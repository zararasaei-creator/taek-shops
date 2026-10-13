import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { hasPermission, requireUser, type AuthUser } from "@/server/auth/authorization";
import { NotFoundError } from "@/server/catalog/errors";

/**
 * Order reads for the storefront confirmation page. An order is visible when the
 * viewer owns it, or is staff (`order.read`), or their browser just placed it
 * (the `taek_orders` cookie — checked by the caller and passed as `justPlaced`).
 * Anything else is a 404, never a 403, so order numbers cannot be probed.
 */

type Db = Pick<PrismaClient, "order">;

const orderView = {
  id: true,
  orderNumber: true,
  status: true,
  paymentStatus: true,
  fulfillmentStatus: true,
  currency: true,
  customerEmail: true,
  subtotalCents: true,
  discountCents: true,
  shippingCents: true,
  taxCents: true,
  totalCents: true,
  customerNote: true,
  placedAt: true,
  createdAt: true,
  userId: true,
  // Refund amount only — never a provider id, card detail, or audit data.
  payments: { select: { amountCents: true, refundedCents: true } },
  items: {
    orderBy: { createdAt: "asc" },
    select: {
      sku: true,
      productName: true,
      variantName: true,
      optionsSnapshot: true,
      unitPriceCents: true,
      quantity: true,
      lineSubtotalCents: true,
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
} as const;

export interface OrderConfirmationContext {
  user?: AuthUser | null;
  justPlaced?: boolean;
}

export async function getOrderForConfirmation(
  orderNumber: string,
  ctx: OrderConfirmationContext,
  db: Db = prisma,
) {
  const order = await db.order.findUnique({ where: { orderNumber }, select: orderView });
  if (!order) throw new NotFoundError("Order", orderNumber);

  const owns = ctx.user != null && order.userId === ctx.user.id;
  const isStaff = hasPermission(ctx.user, "order.read");
  if (!owns && !isStaff && !ctx.justPlaced) {
    // Do not disclose existence.
    throw new NotFoundError("Order", orderNumber);
  }

  return order;
}

// ---------------------------------------------------------------------------
// Customer order history ("My orders") — strict ownership, no staff bypass,
// no "just placed" cookie bypass. A guest order (`userId` null) never appears
// here, even if its `customerEmail` matches the signed-in user's own email —
// attaching a guest order to an account happens nowhere in this codebase, on
// purpose, and this query must not become the place that starts.
// ---------------------------------------------------------------------------

const myOrderListSelect = {
  id: true,
  orderNumber: true,
  createdAt: true,
  currency: true,
  totalCents: true,
  status: true,
  paymentStatus: true,
  fulfillmentStatus: true,
} satisfies Prisma.OrderSelect;

export type MyOrderListRow = Prisma.OrderGetPayload<{ select: typeof myOrderListSelect }>;

export interface ListMyOrdersOptions {
  skip?: number;
  take?: number;
}

/** The signed-in user's own orders, newest first. Requires authentication. */
export async function listMyOrders(
  user: AuthUser | null | undefined,
  options: ListMyOrdersOptions = {},
  db: Db = prisma,
): Promise<{ orders: MyOrderListRow[]; total: number }> {
  const authed = requireUser(user);
  const take = Math.min(Math.max(options.take ?? 10, 1), 50);
  const skip = Math.max(options.skip ?? 0, 0);
  const where: Prisma.OrderWhereInput = { userId: authed.id };

  const [orders, total] = await Promise.all([
    db.order.findMany({ where, select: myOrderListSelect, orderBy: { createdAt: "desc" }, skip, take }),
    db.order.count({ where }),
  ]);
  return { orders, total };
}

export type MyOrderDetail = Prisma.OrderGetPayload<{ select: typeof orderView }>;

/**
 * One of the signed-in user's own orders, by order number. Never trusts a
 * client-supplied customer id — ownership is checked against the
 * server-resolved `authed.id` only. An order that exists but belongs to
 * someone else 404s exactly like one that doesn't exist, so order numbers
 * can't be probed to learn whether they belong to another customer.
 */
export async function getMyOrderDetail(
  user: AuthUser | null | undefined,
  orderNumber: string,
  db: Db = prisma,
): Promise<MyOrderDetail> {
  const authed = requireUser(user);
  const order = await db.order.findUnique({ where: { orderNumber }, select: orderView });
  if (!order || order.userId !== authed.id) {
    throw new NotFoundError("Order", orderNumber);
  }
  return order;
}
