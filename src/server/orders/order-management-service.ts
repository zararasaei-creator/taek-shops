import {
  FulfillmentStatus,
  OrderEmailType,
  OrderStatus,
  PaymentStatus,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";

import { prisma } from "@/server/db/client";
import { requirePermission, type AuthUser } from "@/server/auth/authorization";
import { recordAudit } from "@/server/audit/audit-service";
import { AUDIT_ACTIONS } from "@/server/audit/actions";
import { InvalidStateTransitionError, NotFoundError } from "@/server/catalog/errors";
import {
  applyOrderStatusTransition,
  type OrderTransitionResult,
} from "@/server/orders/order-inventory";
import { cancelPendingOrder, type CancelPendingOptions } from "@/server/orders/order-cancellation";
import { enqueueOrderEmailTx, kickEmailDispatch } from "@/server/notifications";

/**
 * Order management for the admin UI (Phase 8).
 *
 * Reads and status transitions only — this module never touches inventory
 * directly. `OrderStatus` transitions delegate to
 * `applyOrderStatusTransition` (Phase 5), which is the single place inventory
 * moves for an order (reserve / commit / release / restock), so admin actions
 * get the same atomicity, idempotency, and audit guarantees the payment
 * webhook already relies on.
 *
 * **Payment safety**: `PaymentStatus` is never written here. It is set
 * exclusively by `payment-service.ts`'s webhook-driven `finalizeFromPaymentIntent*`
 * path (Phase 7). Consequently `PENDING → CONFIRMED` — the transition that
 * means "payment succeeded" in this schema — is deliberately excluded from
 * `ADMIN_ORDER_STATUS_TRANSITIONS` below: an admin can never manufacture a paid
 * order. Everything admins *can* do (advance a paid order through fulfilment,
 * or cancel one) is a strict subset of the full `ORDER_STATUS_TRANSITIONS`
 * machine in `order-inventory.ts`.
 */

type Db = PrismaClient;
type Actor = AuthUser | null | undefined;

interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export type OrderSort = "newest" | "oldest" | "total_desc" | "total_asc";

export interface ListOrdersOptions {
  /** Matches order number (exact-ish, case-insensitive) or customer email (contains). */
  search?: string;
  status?: OrderStatus;
  paymentStatus?: PaymentStatus;
  fulfillmentStatus?: FulfillmentStatus;
  sort?: OrderSort;
  skip?: number;
  take?: number;
}

const orderListSelect = {
  id: true,
  orderNumber: true,
  customerEmail: true,
  status: true,
  paymentStatus: true,
  fulfillmentStatus: true,
  currency: true,
  totalCents: true,
  placedAt: true,
  createdAt: true,
} satisfies Prisma.OrderSelect;

export type OrderListRow = Prisma.OrderGetPayload<{ select: typeof orderListSelect }>;

function sortToOrderBy(sort: OrderSort | undefined): Prisma.OrderOrderByWithRelationInput {
  switch (sort) {
    case "oldest":
      return { createdAt: "asc" };
    case "total_desc":
      return { totalCents: "desc" };
    case "total_asc":
      return { totalCents: "asc" };
    case "newest":
    default:
      return { createdAt: "desc" };
  }
}

export async function listOrders(
  actor: Actor,
  options: ListOrdersOptions = {},
  db: Db = prisma,
): Promise<{ orders: OrderListRow[]; total: number }> {
  requirePermission(actor, "order.read");
  const take = Math.min(Math.max(options.take ?? 25, 1), 100);
  const skip = Math.max(options.skip ?? 0, 0);

  const where: Prisma.OrderWhereInput = {
    ...(options.status ? { status: options.status } : {}),
    ...(options.paymentStatus ? { paymentStatus: options.paymentStatus } : {}),
    ...(options.fulfillmentStatus ? { fulfillmentStatus: options.fulfillmentStatus } : {}),
    ...(options.search
      ? {
          OR: [
            { orderNumber: { contains: options.search, mode: "insensitive" } },
            { customerEmail: { contains: options.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [orders, total] = await Promise.all([
    db.order.findMany({
      where,
      select: orderListSelect,
      orderBy: sortToOrderBy(options.sort),
      skip,
      take,
    }),
    db.order.count({ where }),
  ]);
  return { orders, total };
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

const orderDetailSelect = {
  id: true,
  orderNumber: true,
  status: true,
  paymentStatus: true,
  fulfillmentStatus: true,
  currency: true,
  customerEmail: true,
  customerPhone: true,
  subtotalCents: true,
  discountCents: true,
  shippingCents: true,
  taxCents: true,
  totalCents: true,
  customerNote: true,
  placedAt: true,
  cancelledAt: true,
  createdAt: true,
  updatedAt: true,
  items: {
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      sku: true,
      productId: true,
      variantId: true,
      productName: true,
      variantName: true,
      optionsSnapshot: true,
      unitPriceCents: true,
      quantity: true,
      lineSubtotalCents: true,
      lineDiscountCents: true,
      lineTaxCents: true,
      lineTotalCents: true,
    },
  },
  addresses: {
    select: {
      type: true,
      firstName: true,
      lastName: true,
      company: true,
      line1: true,
      line2: true,
      city: true,
      province: true,
      postalCode: true,
      country: true,
      phone: true,
    },
  },
  // Non-sensitive payment display only — provider status + amount + redacted
  // card metadata (brand/last4). Never a client secret, PAN, or Stripe key.
  payments: {
    select: {
      id: true,
      provider: true,
      providerPaymentId: true,
      status: true,
      amountCents: true,
      currency: true,
      refundedCents: true,
      errorMessage: true,
      metadata: true,
      createdAt: true,
      updatedAt: true,
      refunds: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          amountCents: true,
          currency: true,
          status: true,
          reason: true,
          providerRefundId: true,
          errorMessage: true,
          createdAt: true,
        },
      },
    },
  },
  discounts: { select: { code: true, description: true, amountCents: true } },
} satisfies Prisma.OrderSelect;

export type OrderDetail = Prisma.OrderGetPayload<{ select: typeof orderDetailSelect }>;

export async function getOrderDetail(
  actor: Actor,
  orderId: string,
  db: Db = prisma,
): Promise<OrderDetail> {
  requirePermission(actor, "order.read");
  const order = await db.order.findUnique({ where: { id: orderId }, select: orderDetailSelect });
  if (!order) throw new NotFoundError("Order", orderId);
  return order;
}

// ---------------------------------------------------------------------------
// Order status (delegates inventory-affecting moves to order-inventory.ts)
// ---------------------------------------------------------------------------

/**
 * The transitions an admin may request directly, deliberately a strict subset
 * of `ORDER_STATUS_TRANSITIONS` — `PENDING → CONFIRMED` (payment success) is
 * excluded so a status change can never stand in for a real Stripe payment.
 */
export const ADMIN_ORDER_STATUS_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  [OrderStatus.PENDING]: [OrderStatus.CANCELLED],
  [OrderStatus.CONFIRMED]: [OrderStatus.PROCESSING, OrderStatus.CANCELLED],
  [OrderStatus.PROCESSING]: [OrderStatus.COMPLETED, OrderStatus.CANCELLED],
  [OrderStatus.COMPLETED]: [],
  [OrderStatus.CANCELLED]: [],
};

export function canAdminTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ADMIN_ORDER_STATUS_TRANSITIONS[from].includes(to);
}

export async function changeOrderStatus(
  actor: Actor,
  orderId: string,
  targetStatus: OrderStatus,
  db: Db = prisma,
  options: Omit<CancelPendingOptions, "db"> = {},
): Promise<OrderTransitionResult> {
  // `order.write` is enforced again inside `applyOrderStatusTransition`; checked
  // here too so the admin-only-transition error below never leaks state to a
  // caller who couldn't act on it anyway.
  requirePermission(actor, "order.write");

  const current = await db.order.findUnique({
    where: { id: orderId },
    select: { status: true, orderNumber: true },
  });
  if (!current) throw new NotFoundError("Order", orderId);

  if (current.status !== targetStatus && !canAdminTransitionOrder(current.status, targetStatus)) {
    const hint =
      current.status === OrderStatus.PENDING && targetStatus === OrderStatus.CONFIRMED
        ? " Orders are confirmed automatically once Stripe payment succeeds — this cannot be done manually."
        : "";
    throw new InvalidStateTransitionError(
      `Order ${current.orderNumber} cannot move from ${current.status} to ${targetStatus}.${hint}`,
    );
  }

  // Cancelling a PENDING order must be provider-aware: a linked PaymentIntent
  // may still be payable (or already paid), and stock may only be released
  // once the provider has confirmed cancellation — see `order-cancellation.ts`.
  if (current.status === OrderStatus.PENDING && targetStatus === OrderStatus.CANCELLED) {
    return cancelPendingOrder(actor, orderId, { ...options, db });
  }

  return applyOrderStatusTransition(actor, orderId, targetStatus, db);
}

// ---------------------------------------------------------------------------
// Fulfilment status — informational shipping tracker, independent of payment
// status and of the inventory-affecting `OrderStatus` machine. Setting it
// never reserves, commits, releases, or restocks inventory: stock already
// moved (reserve at placement, commit at payment) or never will (cancelled).
// ---------------------------------------------------------------------------

export const FULFILLMENT_TRANSITIONS: Record<FulfillmentStatus, readonly FulfillmentStatus[]> = {
  [FulfillmentStatus.UNFULFILLED]: [
    FulfillmentStatus.PARTIALLY_FULFILLED,
    FulfillmentStatus.FULFILLED,
  ],
  [FulfillmentStatus.PARTIALLY_FULFILLED]: [FulfillmentStatus.FULFILLED],
  [FulfillmentStatus.FULFILLED]: [FulfillmentStatus.RETURNED],
  [FulfillmentStatus.RETURNED]: [],
};

export function canTransitionFulfillment(from: FulfillmentStatus, to: FulfillmentStatus): boolean {
  return FULFILLMENT_TRANSITIONS[from].includes(to);
}

export interface FulfillmentTransitionResult {
  orderId: string;
  from: FulfillmentStatus;
  to: FulfillmentStatus;
}

export async function changeOrderFulfillmentStatus(
  actor: Actor,
  orderId: string,
  targetStatus: FulfillmentStatus,
  meta: Meta = {},
  db: Db = prisma,
): Promise<FulfillmentTransitionResult> {
  const authed = requirePermission(actor, "order.write");

  const order = await db.order.findUnique({
    where: { id: orderId },
    select: { orderNumber: true, status: true, paymentStatus: true, fulfillmentStatus: true },
  });
  if (!order) throw new NotFoundError("Order", orderId);

  if (order.status === OrderStatus.CANCELLED) {
    throw new InvalidStateTransitionError(
      `Order ${order.orderNumber} is cancelled; nothing to fulfil.`,
    );
  }
  // Fulfilment tracks shipping of a *paid* order — gated on PaymentStatus, not
  // OrderStatus, to keep the two axes independent per the Phase 8 requirement.
  if (order.paymentStatus !== PaymentStatus.PAID) {
    throw new InvalidStateTransitionError(
      `Order ${order.orderNumber} is not paid yet; nothing to fulfil.`,
    );
  }

  const from = order.fulfillmentStatus;
  if (from === targetStatus) return { orderId, from, to: targetStatus };
  if (!canTransitionFulfillment(from, targetStatus)) {
    throw new InvalidStateTransitionError(
      `Order ${order.orderNumber}'s fulfilment cannot move from ${from} to ${targetStatus}.`,
    );
  }

  // Wrapped in one transaction (Phase 8) so the status change and the
  // shipping-notification job (when applicable) commit together, or
  // neither does — a transport failure downstream must never be able to
  // undo an already-recorded fulfilment change, and a rolled-back change
  // must never leave a stray job behind.
  await db.$transaction(async (tx) => {
    await tx.order.update({ where: { id: orderId }, data: { fulfillmentStatus: targetStatus } });

    await recordAudit(
      {
        action: AUDIT_ACTIONS.ORDER_FULFILLMENT_STATUS_CHANGED,
        actorUserId: authed.id,
        entityType: "Order",
        entityId: orderId,
        metadata: { orderNumber: order.orderNumber, from, to: targetStatus },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
      tx,
    );

    // Only the transition INTO fully-shipped triggers a notification — not
    // partial fulfilment, not the (structurally unreachable, but checked
    // anyway by `enqueueOrderEmailTx`'s own idempotency) case of reaching
    // FULFILLED more than once.
    if (targetStatus === FulfillmentStatus.FULFILLED) {
      await enqueueOrderEmailTx(tx, orderId, OrderEmailType.SHIPPING_NOTIFICATION);
    }
  });

  // Post-commit, best-effort (Phase 8) — never throws; see `kickEmailDispatch`.
  if (targetStatus === FulfillmentStatus.FULFILLED) {
    await kickEmailDispatch(db);
  }

  return { orderId, from, to: targetStatus };
}
