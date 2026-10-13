import {
  OrderStatus,
  PaymentStatus,
  PaymentTransactionStatus,
  Prisma,
  type PrismaClient,
} from "@prisma/client";

import { prisma } from "@/server/db/client";
import { requirePermission, type AuthUser } from "@/server/auth/authorization";
import { recordAudit } from "@/server/audit/audit-service";
import { AUDIT_ACTIONS } from "@/server/audit/actions";
import { ConflictError, InvalidStateTransitionError, NotFoundError } from "@/server/catalog/errors";
import {
  commitReservationTx,
  releaseReservationTx,
  reserveStockTx,
  restockTx,
} from "@/server/inventory/inventory-service";

/**
 * Order ⇄ inventory wiring.
 *
 * The order lifecycle drives four inventory operations, each built from the
 * transaction-composable primitives in `inventory-service.ts`:
 *
 *   placement (→ PENDING)          reserve   every line's quantity
 *   → CONFIRMED                     commit    the reservations (stock is sold)
 *   → CANCELLED (from PENDING)      release   the reservations
 *   → CANCELLED (after CONFIRMED)   restock   the committed units
 *   return / refund (Phase 8)      restock   the returned units
 *
 * Guarantees:
 * - **Atomic** — every line of an operation runs in one `$transaction`; a
 *   failure on any line rolls the whole operation back (no partial reserve).
 * - **Idempotent** — each line carries a deterministic movement key
 *   (`order:<id>:<op>:<variantId>`); replaying an operation is a no-op, so a
 *   retried webhook / double-clicked admin action cannot double-count.
 * - **Deadlock-free** — lines are locked in ascending `variantId` order, so two
 *   orders sharing variants never acquire locks in opposite orders.
 * - **No overselling** — each line goes through `reserveStockTx`, which locks the
 *   row `FOR UPDATE` and re-checks availability against freshly committed data.
 */

type Db = PrismaClient;
type Actor = AuthUser | null | undefined;
type Tx = Prisma.TransactionClient;

export type OrderInventoryOp = "reserve" | "commit" | "release" | "restock";

const TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 } as const;

const AUDIT_ACTION_FOR: Record<
  OrderInventoryOp,
  (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS]
> = {
  reserve: AUDIT_ACTIONS.INVENTORY_RESERVED,
  commit: AUDIT_ACTIONS.INVENTORY_COMMITTED,
  release: AUDIT_ACTIONS.INVENTORY_RELEASED,
  restock: AUDIT_ACTIONS.INVENTORY_RESTOCKED,
};

// ---------------------------------------------------------------------------
// Order-status state machine (inventory-relevant subset)
// ---------------------------------------------------------------------------

/**
 * Legal `OrderStatus` transitions. Deliberately small — the full order state
 * machine (fulfilment, refunds) is Phase 8; this is the subset Phase 5 needs to
 * drive inventory correctly.
 */
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  [OrderStatus.PENDING]: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
  [OrderStatus.CONFIRMED]: [OrderStatus.PROCESSING, OrderStatus.CANCELLED],
  [OrderStatus.PROCESSING]: [OrderStatus.COMPLETED, OrderStatus.CANCELLED],
  [OrderStatus.COMPLETED]: [],
  [OrderStatus.CANCELLED]: [],
};

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_STATUS_TRANSITIONS[from].includes(to);
}

/** Which inventory operation a status transition triggers, if any. */
export function inventoryEffectForTransition(
  from: OrderStatus,
  to: OrderStatus,
): OrderInventoryOp | null {
  if (to === OrderStatus.CONFIRMED) return "commit";
  if (to === OrderStatus.CANCELLED) return from === OrderStatus.PENDING ? "release" : "restock";
  return null;
}

// ---------------------------------------------------------------------------
// Line loading
// ---------------------------------------------------------------------------

interface OrderLine {
  variantId: string;
  quantity: number;
}

export interface OrderForInventory {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  lines: OrderLine[];
}

export interface LockedOrder {
  id: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
}

/**
 * Acquire a row-level exclusive lock (`SELECT ... FOR UPDATE`) on an `Order`
 * row — the abandoned-checkout reservation-recovery equivalent of
 * `lockInventoryItem` (`src/server/inventory/inventory-lock.ts`), same
 * pattern, same reasoning: a plain read gives no serialization guarantee
 * under PostgreSQL's default READ COMMITTED isolation, so two transactions
 * that each only READ before deciding what to write can both "win" a race
 * that looks, from either one's point of view, like it checked first. This
 * lock is what makes `startPayment`'s payment-creation claim and
 * `applyOrderStatusTransitionTx`'s cancellation genuinely mutually
 * exclusive per order — not merely unlikely to overlap.
 *
 * Exported for `src/server/orders/payment-service.ts`'s `startPayment` to
 * acquire the SAME lock before claiming a payment attempt — without that,
 * `startPayment`'s own transaction would only ever perform plain reads,
 * which PostgreSQL does not block against another transaction's `FOR
 * UPDATE`, and the two code paths would not actually serialize at all.
 */
export async function lockOrderRow(
  tx: Pick<Tx, "$queryRaw">,
  orderId: string,
): Promise<LockedOrder | null> {
  const rows = await tx.$queryRaw<LockedOrder[]>(Prisma.sql`
    SELECT "id", "status", "paymentStatus" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE
  `);
  return rows[0] ?? null;
}

async function loadOrderForInventory(
  tx: Tx,
  orderId: string,
): Promise<OrderForInventory> {
  // Locks first — every caller of this function (every inventory-affecting
  // status transition) now serializes per-order against any other
  // transaction that also locks this row, including `startPayment`'s
  // payment-creation claim (see `lockOrderRow`'s own comment). Re-reading
  // via the ORM immediately after reflects whatever the lock acquisition
  // itself already made current — this doesn't re-introduce a gap.
  const locked = await lockOrderRow(tx, orderId);
  if (!locked) throw new NotFoundError("Order", orderId);

  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      items: { select: { variantId: true, quantity: true } },
    },
  });
  if (!order) throw new NotFoundError("Order", orderId);

  // Aggregate by variant (an order may legitimately carry two lines for the same
  // variant) and lock in a deterministic order.
  const byVariant = new Map<string, number>();
  for (const item of order.items) {
    if (!item.variantId) continue; // snapshot-only line; nothing live to move
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) continue;
    byVariant.set(item.variantId, (byVariant.get(item.variantId) ?? 0) + item.quantity);
  }
  const lines = [...byVariant.entries()]
    .map(([variantId, quantity]) => ({ variantId, quantity }))
    .sort((a, b) => a.variantId.localeCompare(b.variantId));

  return { id: order.id, orderNumber: order.orderNumber, status: order.status, lines };
}

async function applyOpToLines(
  tx: Tx,
  order: OrderForInventory,
  op: OrderInventoryOp,
): Promise<void> {
  for (const line of order.lines) {
    const key = `order:${order.id}:${op}:${line.variantId}`;
    if (op === "reserve") {
      await reserveStockTx(tx, line.variantId, line.quantity, order.orderNumber, key);
    } else if (op === "commit") {
      await commitReservationTx(tx, line.variantId, line.quantity, order.orderNumber, key);
    } else if (op === "release") {
      await releaseReservationTx(tx, line.variantId, line.quantity, order.orderNumber, key);
    } else {
      await restockTx(tx, line.variantId, line.quantity, order.orderNumber, key);
    }
  }
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

export interface OrderInventoryResult {
  orderId: string;
  orderNumber: string;
  op: OrderInventoryOp;
  lines: number;
}

/**
 * Reserve stock for every line of an order. Call this when the order is created
 * (status PENDING). Idempotent; atomic across all lines.
 */
export async function reserveOrderStock(
  actor: Actor,
  orderId: string,
  db: Db = prisma,
): Promise<OrderInventoryResult> {
  return runOrderOp(actor, orderId, "reserve", db);
}

/** Commit (sell) an order's reservations. */
export async function commitOrderStock(
  actor: Actor,
  orderId: string,
  db: Db = prisma,
): Promise<OrderInventoryResult> {
  return runOrderOp(actor, orderId, "commit", db);
}

/** Release an order's reservations (cancellation before commit). */
export async function releaseOrderStock(
  actor: Actor,
  orderId: string,
  db: Db = prisma,
): Promise<OrderInventoryResult> {
  return runOrderOp(actor, orderId, "release", db);
}

/** Return committed units to on-hand (cancellation after commit, or a refund). */
export async function restockOrderStock(
  actor: Actor,
  orderId: string,
  db: Db = prisma,
): Promise<OrderInventoryResult> {
  return runOrderOp(actor, orderId, "restock", db);
}

async function runOrderOp(
  actor: Actor,
  orderId: string,
  op: OrderInventoryOp,
  db: Db,
): Promise<OrderInventoryResult> {
  const authed = requirePermission(actor, "order.write");

  const order = await db.$transaction(async (tx) => {
    const loaded = await loadOrderForInventory(tx, orderId);
    await applyOpToLines(tx, loaded, op);
    return loaded;
  }, TX_OPTIONS);

  await recordAudit(
    {
      action: AUDIT_ACTION_FOR[op],
      actorUserId: authed.id,
      entityType: "Order",
      entityId: orderId,
      metadata: { orderNumber: order.orderNumber, op, lines: order.lines.length },
    },
    db,
  );

  return { orderId, orderNumber: order.orderNumber, op, lines: order.lines.length };
}

// ---------------------------------------------------------------------------
// Status transition + inventory effect (atomic)
// ---------------------------------------------------------------------------

export interface OrderTransitionResult {
  orderId: string;
  from: OrderStatus;
  to: OrderStatus;
  inventoryEffect: OrderInventoryOp | null;
}

export interface OrderTransitionTxResult {
  from: OrderStatus;
  to: OrderStatus;
  effect: OrderInventoryOp | null;
  order: OrderForInventory;
}

/**
 * The transaction body of a status transition: validate, apply the inventory
 * effect, write the status + stamps. Assumes the caller already opened the
 * transaction and authorized. Phase 7's payment webhook composes this with its
 * own `Payment` / `WebhookEvent` writes so payment + stock move atomically.
 */
export async function applyOrderStatusTransitionTx(
  tx: Tx,
  orderId: string,
  targetStatus: OrderStatus,
): Promise<OrderTransitionTxResult> {
  const order = await loadOrderForInventory(tx, orderId);
  const from = order.status;

  if (from === targetStatus) {
    return { from, to: targetStatus, effect: null, order };
  }
  if (!canTransitionOrder(from, targetStatus)) {
    throw new InvalidStateTransitionError(
      `Order ${order.orderNumber} cannot move from ${from} to ${targetStatus}.`,
    );
  }

  const effect = inventoryEffectForTransition(from, targetStatus);

  // A `release` effect means PENDING -> CANCELLED before any payment has
  // settled. THE INVARIANT enforced here, structurally, for EVERY caller
  // (expiry sweep, admin cancel, payment-failure finalization): stock is
  // never released while a payment against the order could still be payable
  // or succeed. A `Payment` row that is not locally terminal
  // (`FAILED`/`CANCELLED`) is exactly that possibility:
  //  - `providerPaymentId: null` — an unresolved creation claim
  //    (`startPayment` writes it BEFORE calling the provider): a real
  //    PaymentIntent may exist, or be about to;
  //  - a linked id — a provider PaymentIntent that nothing has yet
  //    authoritatively confirmed cancelled. The only callers that may release
  //    are those that first moved the row to a terminal status AFTER the
  //    provider confirmed cancellation (`finalizeFailureTx`), so this never
  //    blocks them. An admin cancel must go through the provider-aware flow
  //    (`order-cancellation.ts`) — never straight to this function.
  // Refuse rather than guess; the check runs under the Order row lock taken
  // by `loadOrderForInventory`, so it cannot interleave with a claim commit.
  if (effect === "release") {
    const livePayment = await tx.payment.findFirst({
      where: {
        orderId,
        status: { notIn: [PaymentTransactionStatus.FAILED, PaymentTransactionStatus.CANCELLED] },
      },
      select: { providerPaymentId: true },
    });
    if (livePayment) {
      throw new ConflictError(
        livePayment.providerPaymentId === null
          ? `Order ${order.orderNumber} has a payment attempt in progress — refusing to cancel until it is reconciled.`
          : `Order ${order.orderNumber} has a payment that the provider has not confirmed cancelled — refusing to release its stock.`,
      );
    }
  }

  if (effect) await applyOpToLines(tx, order, effect);

  await tx.order.update({
    where: { id: orderId },
    data: {
      status: targetStatus,
      ...(targetStatus === OrderStatus.CONFIRMED && from === OrderStatus.PENDING
        ? { placedAt: new Date() }
        : {}),
      ...(targetStatus === OrderStatus.CANCELLED ? { cancelledAt: new Date() } : {}),
    },
  });

  return { from, to: targetStatus, effect, order };
}

/**
 * Move an order to `targetStatus`, applying the matching inventory operation and
 * the status write in one transaction. Rejects illegal transitions. Persists
 * `placedAt` / `cancelledAt` stamps. The broader order state machine
 * (payment/fulfilment status, refunds) is Phase 8 and layers on top of this.
 */
export async function applyOrderStatusTransition(
  actor: Actor,
  orderId: string,
  targetStatus: OrderStatus,
  db: Db = prisma,
): Promise<OrderTransitionResult> {
  const authed = requirePermission(actor, "order.write");

  const result = await db.$transaction(
    (tx) => applyOrderStatusTransitionTx(tx, orderId, targetStatus),
    TX_OPTIONS,
  );

  await recordAudit(
    {
      action: AUDIT_ACTIONS.ORDER_STATUS_CHANGED,
      actorUserId: authed.id,
      entityType: "Order",
      entityId: orderId,
      metadata: {
        orderNumber: result.order.orderNumber,
        from: result.from,
        to: result.to,
        inventoryEffect: result.effect,
      },
    },
    db,
  );

  return { orderId, from: result.from, to: result.to, inventoryEffect: result.effect };
}
