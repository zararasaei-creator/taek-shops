// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";

import { CatalogValidationError, NotFoundError } from "@/server/catalog/errors";
import { addToCart, getCartSummary, updateCartItem } from "@/server/cart/cart-service";
import { createMockPrisma, looseMock, type MockPrisma } from "./helpers/mock-prisma";

function variantRow(
  over: Partial<{
    active: boolean;
    priceCents: number;
    status: string;
    productActive: boolean;
  }> = {},
) {
  return {
    id: "v1",
    sku: "SKU-1",
    name: "White / 140",
    priceCents: over.priceCents ?? 4000,
    currency: "CAD",
    weightGrams: 600,
    active: over.active ?? true,
    product: {
      id: "p1",
      name: "Dobok",
      slug: "dobok",
      status: over.status ?? "ACTIVE",
      active: over.productActive ?? true,
      taxCategory: "standard",
    },
    optionValues: [],
  };
}

function primeCart(db: MockPrisma) {
  db.cart.findFirst.mockResolvedValue({ id: "c1", token: "tok", userId: null } as never);
  db.cart.create.mockResolvedValue({ id: "c1", token: "tok", userId: null } as never);
  db.cartItem.upsert.mockResolvedValue({} as never);
  db.cartItem.updateMany.mockResolvedValue({ count: 1 } as never);
  db.cartItem.deleteMany.mockResolvedValue({ count: 1 } as never);
}

describe("cart-service", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
    primeCart(db);
  });

  it("refuses to add an unavailable variant", async () => {
    db.productVariant.findUnique.mockResolvedValue(variantRow({ active: false }) as never);
    await expect(
      addToCart({ token: "tok" }, { variantId: "v1", quantity: 1 }, db),
    ).rejects.toBeInstanceOf(CatalogValidationError);

    db.productVariant.findUnique.mockResolvedValue(null as never);
    await expect(
      addToCart({ token: "tok" }, { variantId: "v1", quantity: 1 }, db),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("recomputes the line subtotal from the current catalogue price", async () => {
    db.productVariant.findUnique.mockResolvedValue(variantRow({ priceCents: 4000 }) as never);
    db.cartItem.findUnique.mockResolvedValue({ quantity: 1 } as never);
    db.cartItem.findMany.mockResolvedValue([
      { id: "ci1", quantity: 3, variant: variantRow({ priceCents: 4000 }) },
    ] as never);

    const summary = await addToCart({ token: "tok" }, { variantId: "v1", quantity: 2 }, db);
    expect(summary.lines[0]).toMatchObject({
      unitPriceCents: 4000,
      quantity: 3,
      lineSubtotalCents: 12000,
    });
    expect(summary.subtotalCents).toBe(12000);
    // upsert was asked for quantity 1 (existing) + 2 = 3
    expect(db.cartItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { quantity: 3 },
        create: expect.objectContaining({ quantity: 3 }),
      }),
    );
  });

  it("clamps the line quantity to the maximum", async () => {
    db.productVariant.findUnique.mockResolvedValue(variantRow() as never);
    db.cartItem.findUnique.mockResolvedValue({ quantity: 98 } as never);
    db.cartItem.findMany.mockResolvedValue([] as never);
    await addToCart({ token: "tok" }, { variantId: "v1", quantity: 50 }, db);
    expect(db.cartItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { quantity: 99 } }),
    );
  });

  it("getCartSummary drops a line whose variant is no longer sellable", async () => {
    looseMock(db.cartItem.findMany).mockImplementation(() =>
      Promise.resolve([
        { id: "ci1", quantity: 1, variant: variantRow({ status: "ARCHIVED" }) },
        { id: "ci2", quantity: 2, variant: variantRow({ priceCents: 1000 }) },
      ]),
    );
    const summary = await getCartSummary("c1", "tok", db);
    expect(summary.lines).toHaveLength(1);
    expect(summary.removedUnavailable).toEqual(["SKU-1"]);
    expect(db.cartItem.delete).toHaveBeenCalledWith({ where: { id: "ci1" } });
    expect(summary.subtotalCents).toBe(2000);
  });

  it("updateCartItem with quantity 0 removes the line", async () => {
    db.cartItem.findMany.mockResolvedValue([] as never);
    await updateCartItem({ token: "tok" }, { variantId: "v1", quantity: 0 }, db);
    expect(db.cartItem.deleteMany).toHaveBeenCalledWith({
      where: { cartId: "c1", variantId: "v1" },
    });
  });
});
