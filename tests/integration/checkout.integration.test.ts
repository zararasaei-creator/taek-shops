import { OrderStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { InventoryRuleError } from "@/server/catalog/errors";
import { addToCart } from "@/server/cart/cart-service";
import { placeOrder, quoteCheckout } from "@/server/orders/checkout-service";
import { cleanup, db, ledgerSums, makeVariant } from "./helpers/db";
import {
  cleanupCheckout,
  ensureTaxAndShippingConfig,
  makeCart,
  placeOrderInput,
  type TestShippingConfig,
} from "./helpers/checkout";

let cfg: TestShippingConfig;

beforeAll(async () => {
  cfg = await ensureTaxAndShippingConfig();
});
afterAll(async () => {
  await cleanupCheckout();
  await cleanup();
  await db.$disconnect();
});

async function cartWith(variantId: string, quantity: number) {
  const cart = await makeCart();
  await addToCart({ token: cart.token }, { variantId, quantity });
  return cart;
}

describe("checkout — quote", () => {
  it("recomputes subtotal, shipping and HST from configured data", async () => {
    const v = await makeVariant({ onHand: 50 }); // $10.00 each
    const cart = await cartWith(v.variantId, 2);

    const quote = await quoteCheckout(
      { token: cart.token },
      { province: "ON", shippingMethodId: cfg.shippingMethodId },
    );
    expect(quote).not.toBeNull();
    expect(quote!.subtotalCents).toBe(2000);
    expect(quote!.shippingCents).toBe(1200); // flat rate, under the free threshold
    expect(quote!.taxCents).toBe(260); // 13% of 2000
    expect(quote!.taxRegionName).toBe("Ontario");
    expect(quote!.totalCents).toBe(2000 + 1200 + 260);
  });

  it("applies the free-shipping threshold", async () => {
    const v = await makeVariant({ onHand: 50 });
    const cart = await cartWith(v.variantId, 20); // $200 subtotal >= $150

    const quote = await quoteCheckout(
      { token: cart.token },
      { province: "ON", shippingMethodId: cfg.shippingMethodId },
    );
    expect(quote!.subtotalCents).toBe(20000);
    expect(quote!.shippingCents).toBe(0);
    expect(quote!.selectedShipping?.free).toBe(true);
  });

  it("returns zero tax for a province with no configured region", async () => {
    const v = await makeVariant({ onHand: 10 });
    const cart = await cartWith(v.variantId, 1);
    const quote = await quoteCheckout({ token: cart.token }, { province: "BC" });
    expect(quote!.taxCents).toBe(0);
    expect(quote!.taxRegionName).toBeNull();
  });
});

describe("checkout — placeOrder", () => {
  it("creates a PENDING order, freezes totals, reserves stock, converts the cart", async () => {
    const v = await makeVariant({ onHand: 12 });
    const cart = await cartWith(v.variantId, 3);

    const placed = await placeOrder({ token: cart.token }, placeOrderInput(cfg.shippingMethodId));
    expect(placed.alreadyExisted).toBe(false);
    expect(placed.status).toBe(OrderStatus.PENDING);

    const order = await db.order.findUniqueOrThrow({
      where: { id: placed.id },
      include: { items: true, addresses: true },
    });
    expect(order.subtotalCents).toBe(3000);
    expect(order.shippingCents).toBe(1200);
    expect(order.taxCents).toBe(390); // 13% of 3000
    expect(order.totalCents).toBe(3000 + 1200 + 390);
    expect(order.paymentStatus).toBe("UNPAID");
    expect(order.items).toHaveLength(1);
    expect(order.items[0]).toMatchObject({
      sku: v.sku,
      unitPriceCents: 1000,
      quantity: 3,
      lineSubtotalCents: 3000,
      lineTaxCents: 390,
      lineTotalCents: 3390,
    });
    expect(order.addresses.map((a) => a.type).sort()).toEqual(["BILLING", "SHIPPING"]);

    // stock reserved, ledger reconciles
    const item = await db.inventoryItem.findUniqueOrThrow({
      where: { id: v.inventoryItemId },
      select: { quantityOnHand: true, quantityReserved: true },
    });
    expect(item).toEqual({ quantityOnHand: 12, quantityReserved: 3 });
    expect((await ledgerSums(v.inventoryItemId)).reserved).toBe(3);

    // cart is spent
    expect((await db.cart.findUniqueOrThrow({ where: { id: cart.id } })).status).toBe("CONVERTED");

    // audit
    expect(
      await db.auditLog.count({ where: { action: "order.placed", entityId: placed.id } }),
    ).toBe(1);
  });

  it("ignores any client-supplied money fields — totals are server-computed", async () => {
    const v = await makeVariant({ onHand: 10 });
    const cart = await cartWith(v.variantId, 1);

    const placed = await placeOrder(
      { token: cart.token },
      {
        ...placeOrderInput(cfg.shippingMethodId),
        // hostile extras — must be stripped / ignored
        subtotalCents: 1,
        totalCents: 1,
        taxCents: 0,
        shippingCents: 0,
        items: [{ unitPriceCents: 1 }],
      },
    );
    const order = await db.order.findUniqueOrThrow({ where: { id: placed.id } });
    expect(order.subtotalCents).toBe(1000);
    expect(order.totalCents).toBe(1000 + 1200 + 130);
  });

  it("is atomic — an under-stocked line places no order and reserves nothing", async () => {
    const v = await makeVariant({ onHand: 2 });
    const cart = await cartWith(v.variantId, 5);

    await expect(
      placeOrder({ token: cart.token }, placeOrderInput(cfg.shippingMethodId)),
    ).rejects.toBeInstanceOf(InventoryRuleError);

    expect(await db.order.count({ where: { cartId: cart.id } })).toBe(0);
    const item = await db.inventoryItem.findUniqueOrThrow({
      where: { id: v.inventoryItemId },
      select: { quantityOnHand: true, quantityReserved: true },
    });
    expect(item).toEqual({ quantityOnHand: 2, quantityReserved: 0 });
    expect((await db.cart.findUniqueOrThrow({ where: { id: cart.id } })).status).toBe("ACTIVE");
  });

  it("is idempotent on the cart — replaying returns the same order, reserves once", async () => {
    const v = await makeVariant({ onHand: 10 });
    const cart = await cartWith(v.variantId, 2);

    const first = await placeOrder({ token: cart.token }, placeOrderInput(cfg.shippingMethodId));
    const second = await placeOrder({ token: cart.token }, placeOrderInput(cfg.shippingMethodId));

    expect(second.id).toBe(first.id);
    expect(second.alreadyExisted).toBe(true);
    expect(await db.order.count({ where: { cartId: cart.id } })).toBe(1);
    expect(
      (await db.inventoryItem.findUniqueOrThrow({ where: { id: v.inventoryItemId } }))
        .quantityReserved,
    ).toBe(2);
  });

  it("rejects an empty cart and an unknown shipping method", async () => {
    const empty = await makeCart();
    await expect(
      placeOrder({ token: empty.token }, placeOrderInput(cfg.shippingMethodId)),
    ).rejects.toThrow();

    const v = await makeVariant({ onHand: 5 });
    const cart = await cartWith(v.variantId, 1);
    await expect(
      placeOrder({ token: cart.token }, placeOrderInput("no-such-method")),
    ).rejects.toThrow();
    expect(await db.order.count({ where: { cartId: cart.id } })).toBe(0);
  });

  it("two shoppers racing the last units cannot oversell", async () => {
    const v = await makeVariant({ onHand: 3 });
    const c1 = await cartWith(v.variantId, 2);
    const c2 = await cartWith(v.variantId, 2);

    const results = await Promise.allSettled([
      placeOrder({ token: c1.token }, placeOrderInput(cfg.shippingMethodId)),
      placeOrder({ token: c2.token }, placeOrderInput(cfg.shippingMethodId)),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(1);

    const item = await db.inventoryItem.findUniqueOrThrow({
      where: { id: v.inventoryItemId },
      select: { quantityOnHand: true, quantityReserved: true },
    });
    expect(item.quantityReserved).toBe(2);
    expect(item.quantityReserved).toBeLessThanOrEqual(item.quantityOnHand);
  });
});
