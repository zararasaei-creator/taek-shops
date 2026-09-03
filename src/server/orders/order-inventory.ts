import { OrderStatus, type Prisma, type PrismaClient } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { requirePermission, type AuthUser } from "@/server/auth/authorization";
import { recordAudit } from "@/server/audit/audit-service";
import { AUDIT_ACTIONS } from "@/server/audit/actions";
import { InvalidStateTransitionError, NotFoundError } from "@/server/catalog/errors";
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

interface OrderForInventory {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  lines: OrderLine[];
}

async function loadOrderForInventory(
  tx: Pick<Tx, "order">,
  orderId: string,
): Promise<OrderForInventory> {
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

  const result = await db.$transaction(async (tx) => {
    const order = await loadOrderForInventory(tx, orderId);
    const from = order.status;

    if (from === targetStatus) {
      return { from, to: targetStatus, effect: null as OrderInventoryOp | null, order };
    }
    if (!canTransitionOrder(from, targetStatus)) {
      throw new InvalidStateTransitionError(
        `Order ${order.orderNumber} cannot move from ${from} to ${targetStatus}.`,
      );
    }

    const effect = inventoryEffectForTransition(from, targetStatus);
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
  }, TX_OPTIONS);

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
