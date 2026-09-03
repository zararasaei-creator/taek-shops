import { randomBytes } from "node:crypto";

import { CartStatus, ProductStatus, type Prisma } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { CatalogValidationError, NotFoundError } from "@/server/catalog/errors";
import { addCents, multiplyCents } from "@/server/domain/money";
import {
  addToCartSchema,
  updateCartItemSchema,
  MAX_CART_LINE_QUANTITY,
} from "@/lib/validation/checkout";

/**
 * Cart service (Phase 6).
 *
 * - Guest carts are keyed by an opaque token; a signed-in customer's carts also
 *   carry `userId`.
 * - **Prices are never taken from the client.** Every read recomputes line
 *   amounts from the current `ProductVariant.priceCents`.
 * - A line is only sellable while its product is `ACTIVE` + `active` and its
 *   variant is `active` — the same rule the public catalogue query enforces.
 */

/** Accepts the shared client or an interactive-transaction client. */
type Db = Prisma.TransactionClient;

export interface CartLine {
  variantId: string;
  productId: string;
  productSlug: string;
  productName: string;
  variantName: string | null;
  sku: string;
  taxCategory: string | null;
  options: { option: string; value: string }[];
  unitPriceCents: number;
  quantity: number;
  lineSubtotalCents: number;
  weightGrams: number;
}

export interface CartSummary {
  cartId: string;
  token: string;
  currency: "CAD";
  lines: CartLine[];
  /** Lines that were dropped because the variant is no longer sellable. */
  removedUnavailable: string[];
  itemCount: number;
  subtotalCents: number;
  totalWeightGrams: number;
}

const cartItemInclude = {
  variant: {
    select: {
      id: true,
      sku: true,
      name: true,
      priceCents: true,
      currency: true,
      weightGrams: true,
      active: true,
      product: {
        select: { id: true, name: true, slug: true, status: true, active: true, taxCategory: true },
      },
      optionValues: {
        select: {
          option: { select: { name: true, position: true } },
          optionValue: { select: { value: true, position: true } },
        },
      },
    },
  },
} satisfies Prisma.CartItemInclude;

type CartItemRow = Prisma.CartItemGetPayload<{ include: typeof cartItemInclude }>;

function sellable(v: CartItemRow["variant"]): boolean {
  return (
    v.active &&
    v.product.active &&
    v.product.status === ProductStatus.ACTIVE &&
    v.currency === "CAD"
  );
}

function toLine(row: CartItemRow): CartLine {
  const v = row.variant;
  return {
    variantId: v.id,
    productId: v.product.id,
    productSlug: v.product.slug,
    productName: v.product.name,
    variantName: v.name,
    sku: v.sku,
    taxCategory: v.product.taxCategory,
    options: v.optionValues
      .map((ov) => ({
        option: ov.option.name,
        value: ov.optionValue.value,
        op: ov.option.position,
        vp: ov.optionValue.position,
      }))
      .sort((a, b) => a.op - b.op || a.vp - b.vp)
      .map(({ option, value }) => ({ option, value })),
    unitPriceCents: v.priceCents,
    quantity: row.quantity,
    lineSubtotalCents: multiplyCents(v.priceCents, row.quantity),
    weightGrams: (v.weightGrams ?? 0) * row.quantity,
  };
}

function newToken(): string {
  return randomBytes(24).toString("base64url");
}

// ---------------------------------------------------------------------------
// Load / create
// ---------------------------------------------------------------------------

export interface CartIdentity {
  token?: string | null;
  userId?: string | null;
}

/** The active cart for this token, or null. Associates `userId` if newly signed in. */
export async function findActiveCart(identity: CartIdentity, db: Db = prisma) {
  if (!identity.token) return null;
  const cart = await db.cart.findFirst({
    where: { token: identity.token, status: CartStatus.ACTIVE },
    select: { id: true, token: true, userId: true },
  });
  if (!cart) return null;
  if (identity.userId && cart.userId !== identity.userId) {
    await db.cart.update({ where: { id: cart.id }, data: { userId: identity.userId } });
  }
  return cart;
}

/** The active cart for this token, creating one (with a fresh token) if needed. */
export async function getOrCreateCart(
  identity: CartIdentity,
  db: Db = prisma,
): Promise<{ id: string; token: string; userId: string | null; created: boolean }> {
  const existing = await findActiveCart(identity, db);
  if (existing) return { ...existing, created: false };

  const token = newToken();
  const cart = await db.cart.create({
    data: { token, userId: identity.userId ?? null, status: CartStatus.ACTIVE },
    select: { id: true, token: true, userId: true },
  });
  return { ...cart, created: true };
}

// ---------------------------------------------------------------------------
// Summary (server-recomputed)
// ---------------------------------------------------------------------------

export async function getCartSummary(
  cartId: string,
  token: string,
  db: Db = prisma,
): Promise<CartSummary> {
  const rows = await db.cartItem.findMany({
    where: { cartId },
    include: cartItemInclude,
    orderBy: { createdAt: "asc" },
  });

  const removedUnavailable: string[] = [];
  const lines: CartLine[] = [];
  for (const row of rows) {
    if (!sellable(row.variant)) {
      removedUnavailable.push(row.variant.sku);
      await db.cartItem.delete({ where: { id: row.id } });
      continue;
    }
    lines.push(toLine(row));
  }

  return {
    cartId,
    token,
    currency: "CAD",
    lines,
    removedUnavailable,
    itemCount: lines.reduce((n, l) => n + l.quantity, 0),
    subtotalCents: lines.length ? addCents(...lines.map((l) => l.lineSubtotalCents)) : 0,
    totalWeightGrams: lines.reduce((g, l) => g + l.weightGrams, 0),
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

async function assertSellable(db: Db, variantId: string): Promise<void> {
  const variant = await db.productVariant.findUnique({
    where: { id: variantId },
    select: {
      active: true,
      currency: true,
      product: { select: { status: true, active: true } },
    },
  });
  if (!variant) throw new NotFoundError("Product variant", variantId);
  if (
    !variant.active ||
    !variant.product.active ||
    variant.product.status !== ProductStatus.ACTIVE ||
    variant.currency !== "CAD"
  ) {
    throw new CatalogValidationError("That item is not available for purchase.");
  }
}

export async function addToCart(
  identity: CartIdentity,
  rawInput: unknown,
  db: Db = prisma,
): Promise<CartSummary> {
  const input = addToCartSchema.parse(rawInput);
  await assertSellable(db, input.variantId);

  const cart = await getOrCreateCart(identity, db);
  const existing = await db.cartItem.findUnique({
    where: { cartId_variantId: { cartId: cart.id, variantId: input.variantId } },
    select: { quantity: true },
  });
  const nextQty = Math.min((existing?.quantity ?? 0) + input.quantity, MAX_CART_LINE_QUANTITY);

  await db.cartItem.upsert({
    where: { cartId_variantId: { cartId: cart.id, variantId: input.variantId } },
    update: { quantity: nextQty },
    create: { cartId: cart.id, variantId: input.variantId, quantity: nextQty },
  });

  return getCartSummary(cart.id, cart.token, db);
}

export async function updateCartItem(
  identity: CartIdentity,
  rawInput: unknown,
  db: Db = prisma,
): Promise<CartSummary> {
  const input = updateCartItemSchema.parse(rawInput);
  const cart = await findActiveCart(identity, db);
  if (!cart) throw new NotFoundError("Cart");

  if (input.quantity === 0) {
    await db.cartItem.deleteMany({ where: { cartId: cart.id, variantId: input.variantId } });
  } else {
    await assertSellable(db, input.variantId);
    const updated = await db.cartItem.updateMany({
      where: { cartId: cart.id, variantId: input.variantId },
      data: { quantity: input.quantity },
    });
    if (updated.count === 0) throw new NotFoundError("Cart item", input.variantId);
  }

  return getCartSummary(cart.id, cart.token, db);
}

export async function removeCartItem(
  identity: CartIdentity,
  variantId: string,
  db: Db = prisma,
): Promise<CartSummary> {
  return updateCartItem(identity, { variantId, quantity: 0 }, db);
}
