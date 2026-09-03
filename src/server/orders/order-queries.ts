import type { PrismaClient } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { hasPermission, type AuthUser } from "@/server/auth/authorization";
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
