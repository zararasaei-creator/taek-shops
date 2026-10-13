import {
  CartStatus,
  FulfillmentStatus,
  OrderStatus,
  PaymentStatus,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";

import { prisma } from "@/server/db/client";
import { recordAudit } from "@/server/audit/audit-service";
import { AUDIT_ACTIONS } from "@/server/audit/actions";
import { CatalogValidationError, NotFoundError } from "@/server/catalog/errors";
import { reserveStockTx } from "@/server/inventory/inventory-service";
import { getTaxCalculator } from "@/server/tax/tax-calculator";
import { getShippingProvider, type ShippingOption } from "@/server/shipping/shipping-provider";
import {
  findActiveCart,
  getCartSummary,
  type CartIdentity,
  type CartLine,
} from "@/server/cart/cart-service";
import { generateOrderNumber } from "@/server/orders/order-number";
import {
  placeOrderSchema,
  type CheckoutAddressInput,
  type PlaceOrderInput,
} from "@/lib/validation/checkout";

/**
 * Checkout (Phase 6 — no real payment).
 *
 * The **order is authoritative, not the cart**: every price, the shipping cost,
 * and the tax are recomputed server-side from the current catalogue and the
 * configured `TaxRegion`/`TaxRate` + `ShippingZone`/`ShippingMethod` tables, then
 * frozen onto the `Order` / `OrderItem` rows. The client cannot influence any
 * amount.
 *
 * `placeOrder` runs in ONE transaction: create the order + items + addresses,
 * reserve stock through the Phase 5 primitive, and convert the cart. Any
 * failure (including insufficient stock) rolls the whole thing back — there is
 * never a partial order or an orphaned reservation. It is idempotent on
 * `Order.cartId` (unique): replaying returns the order that was already placed.
 */

type Db = PrismaClient;
const SHIP_FROM = { country: "CA", province: "" } as const;

interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface CheckoutQuote {
  currency: "CAD";
  lines: (CartLine & { lineTaxCents: number; lineTotalCents: number })[];
  shippingOptions: ShippingOption[];
  selectedShipping: ShippingOption | null;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  taxRegionName: string | null;
  totalCents: number;
}

function addressColumns(a: CheckoutAddressInput) {
  return {
    firstName: a.firstName,
    lastName: a.lastName,
    company: a.company ?? null,
    line1: a.line1,
    line2: a.line2 ?? null,
    city: a.city,
    province: a.province,
    postalCode: a.postalCode,
    country: a.country,
    phone: a.phone ?? null,
  };
}

async function computeQuote(
  db: Prisma.TransactionClient,
  cartId: string,
  token: string,
  province: string | null,
  shippingMethodId: string | null,
): Promise<{ quote: CheckoutQuote; lines: CartLine[] }> {
  const summary = await getCartSummary(cartId, token, db);

  // Shipping + tax are only meaningful once we know the destination province.
  let shippingOptions: ShippingOption[] = [];
  let selectedShipping: ShippingOption | null = null;
  let taxByRef = new Map<string, number>();
  let taxCents = 0;
  let taxRegionName: string | null = null;

  if (province) {
    const dest = { country: "CA", province };
    shippingOptions = await getShippingProvider(db).rates(
      { weightGrams: summary.totalWeightGrams, subtotalCents: summary.subtotalCents },
      SHIP_FROM,
      dest,
    );
    selectedShipping =
      (shippingMethodId
        ? shippingOptions.find((o) => o.methodId === shippingMethodId)
        : shippingOptions[0]) ?? null;

    const taxQuote = await getTaxCalculator(db).quote(
      summary.lines.map((l) => ({
        ref: l.variantId,
        taxableCents: l.lineSubtotalCents,
        taxCategory: l.taxCategory,
      })),
      dest,
    );
    taxRegionName = taxQuote.regionName;
    taxByRef = new Map(taxQuote.lines.map((l) => [l.ref, l.taxCents]));
    taxCents = taxQuote.totalCents;
  }

  const shippingCents = selectedShipping?.priceCents ?? 0;
  const lines = summary.lines.map((l) => {
    const lineTaxCents = taxByRef.get(l.variantId) ?? 0;
    return { ...l, lineTaxCents, lineTotalCents: l.lineSubtotalCents + lineTaxCents };
  });

  return {
    lines: summary.lines,
    quote: {
      currency: "CAD",
      lines,
      shippingOptions,
      selectedShipping,
      subtotalCents: summary.subtotalCents,
      shippingCents,
      taxCents,
      taxRegionName,
      totalCents: summary.subtotalCents + shippingCents + taxCents,
    },
  };
}

/**
 * A read-only checkout quote for rendering the review step. Pass the chosen
 * `province` to get shipping options and tax; omit it before the address is
 * entered.
 */
export async function quoteCheckout(
  identity: CartIdentity,
  opts: { province?: string | null; shippingMethodId?: string | null } = {},
  db: Db = prisma,
): Promise<CheckoutQuote | null> {
  const cart = await findActiveCart(identity, db);
  if (!cart) return null;
  const { quote } = await computeQuote(
    db,
    cart.id,
    cart.token,
    opts.province ?? null,
    opts.shippingMethodId ?? null,
  );
  return quote;
}

export interface PlacedOrder {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  totalCents: number;
  alreadyExisted: boolean;
}

export async function placeOrder(
  identity: CartIdentity,
  rawInput: unknown,
  meta: Meta = {},
  db: Db = prisma,
): Promise<PlacedOrder> {
  const input: PlaceOrderInput = placeOrderSchema.parse(rawInput);

  if (!identity.token) throw new NotFoundError("Cart");

  // Idempotency: one order per cart (unique Order.cartId). Check BEFORE requiring
  // an *active* cart — a successful placement converts the cart, so a replay
  // must still resolve to the order that was already created.
  const existing = await db.order.findFirst({
    where: { cart: { token: identity.token } },
    select: { id: true, orderNumber: true, status: true, totalCents: true },
  });
  if (existing) {
    return { ...existing, alreadyExisted: true };
  }

  const cart = await findActiveCart(identity, db);
  if (!cart) throw new NotFoundError("Cart");

  const placed = await db.$transaction(
    async (tx) => {
      const { quote, lines } = await computeQuote(
        tx,
        cart.id,
        cart.token,
        input.shippingAddress.province,
        input.shippingMethodId,
      );

      if (lines.length === 0) {
        throw new CatalogValidationError("Your cart is empty.");
      }
      if (!quote.selectedShipping || quote.selectedShipping.methodId !== input.shippingMethodId) {
        throw new CatalogValidationError("The selected shipping method is not available.");
      }

      const taxByRef = new Map(quote.lines.map((l) => [l.variantId, l.lineTaxCents]));
      const orderNumber = await generateOrderNumber(tx);

      const order = await tx.order.create({
        data: {
          orderNumber,
          cartId: cart.id,
          // Ownership comes from WHO IS PLACING THE ORDER NOW, never from a stale
          // `cart.userId`: a cart first used while signed in, then continued as a
          // guest after sign-out, must not attach the guest's order to that
          // customer's history. (`findActiveCart` already re-points the cart at
          // the signed-in user, so an authenticated order is always theirs.)
          userId: identity.userId ?? null,
          customerEmail: input.email,
          customerPhone: input.shippingAddress.phone ?? null,
          status: OrderStatus.PENDING,
          paymentStatus: PaymentStatus.UNPAID,
          fulfillmentStatus: FulfillmentStatus.UNFULFILLED,
          currency: "CAD",
          subtotalCents: quote.subtotalCents,
          discountCents: 0,
          shippingCents: quote.shippingCents,
          taxCents: quote.taxCents,
          totalCents: quote.totalCents,
          customerNote: input.customerNote ?? null,
          placedAt: new Date(),
          items: {
            create: lines.map((l) => {
              const lineTaxCents = taxByRef.get(l.variantId) ?? 0;
              return {
                productId: l.productId,
                variantId: l.variantId,
                sku: l.sku,
                productName: l.productName,
                variantName: l.variantName,
                ...(l.options.length ? { optionsSnapshot: l.options } : {}),
                unitPriceCents: l.unitPriceCents,
                quantity: l.quantity,
                lineSubtotalCents: l.lineSubtotalCents,
                lineDiscountCents: 0,
                lineTaxCents,
                lineTotalCents: l.lineSubtotalCents + lineTaxCents,
              };
            }),
          },
          addresses: {
            create: [
              { type: "SHIPPING", ...addressColumns(input.shippingAddress) },
              { type: "BILLING", ...addressColumns(input.billingAddress ?? input.shippingAddress) },
            ],
          },
        },
        select: { id: true, orderNumber: true, status: true, totalCents: true },
      });

      // Reserve stock atomically in this same transaction. Deterministic lock
      // order (ascending variantId) — same rule as src/server/orders/order-inventory.ts.
      const reserveLines = [...lines].sort((a, b) => a.variantId.localeCompare(b.variantId));
      for (const line of reserveLines) {
        await reserveStockTx(
          tx,
          line.variantId,
          line.quantity,
          order.orderNumber,
          `order:${order.id}:reserve:${line.variantId}`,
        );
      }

      await tx.cart.update({ where: { id: cart.id }, data: { status: CartStatus.CONVERTED } });

      return { order, lineCount: lines.length };
    },
    { timeout: 20_000, maxWait: 10_000 },
  );

  await recordAudit(
    {
      action: AUDIT_ACTIONS.ORDER_PLACED,
      actorUserId: identity.userId ?? null,
      entityType: "Order",
      entityId: placed.order.id,
      metadata: {
        orderNumber: placed.order.orderNumber,
        totalCents: placed.order.totalCents,
        lineCount: placed.lineCount,
        province: input.shippingAddress.province,
      },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
    db,
  );

  return { ...placed.order, alreadyExisted: false };
}
