import { db } from "./db";

/**
 * Phase 6 (cart & checkout) integration fixtures. Layered on the Phase 5 helpers
 * (`makeVariant`, `ensureActor`, `teardown`) — this file adds cart + tax/shipping
 * config + checkout cleanup.
 *
 * Namespacing for exact cleanup:
 *   - carts  : token starts `pf6-`
 *   - orders : customerEmail contains `phase6`
 * Tax/shipping config is *upserted* onto the same rows the seed uses (never
 * deleted) so it is present regardless of seed state.
 */

export const TEST_CART_TOKEN_PREFIX = "pf6-";
export const TEST_ORDER_EMAIL = "buyer.phase6@taek.local";

let n = 0;
export function cartToken(): string {
  n += 1;
  return `${TEST_CART_TOKEN_PREFIX}${Date.now().toString(36)}${n}`;
}

export interface TestShippingConfig {
  shippingMethodId: string;
  flatRateCents: number;
  freeShippingThresholdCents: number;
  hstRate: string;
}

/** Ensure the example Ontario/HST tax rows and Canada/Standard shipping rows. */
export async function ensureTaxAndShippingConfig(): Promise<TestShippingConfig> {
  const region = await db.taxRegion.upsert({
    where: { country_province: { country: "CA", province: "ON" } },
    update: { name: "Ontario", active: true },
    create: { name: "Ontario", country: "CA", province: "ON" },
  });
  await db.taxRate.upsert({
    where: { regionId_name_taxCategory: { regionId: region.id, name: "HST", taxCategory: "" } },
    update: { rate: "0.130000", active: true, compound: false, priority: 0 },
    create: { regionId: region.id, name: "HST", taxCategory: "", rate: "0.130000" },
  });

  const zone = await db.shippingZone.upsert({
    where: { name: "Canada" },
    update: { active: true },
    create: { name: "Canada" },
  });
  await db.shippingZoneRegion.upsert({
    where: { zoneId_country_province: { zoneId: zone.id, country: "CA", province: "" } },
    update: {},
    create: { zoneId: zone.id, country: "CA", province: "" },
  });
  const method = await db.shippingMethod.upsert({
    where: { zoneId_name: { zoneId: zone.id, name: "Standard" } },
    update: {
      flatRateCents: 1200,
      freeShippingThresholdCents: 15000,
      minDeliveryDays: 3,
      maxDeliveryDays: 7,
      active: true,
    },
    create: {
      zoneId: zone.id,
      name: "Standard",
      flatRateCents: 1200,
      freeShippingThresholdCents: 15000,
      minDeliveryDays: 3,
      maxDeliveryDays: 7,
    },
  });

  return {
    shippingMethodId: method.id,
    flatRateCents: 1200,
    freeShippingThresholdCents: 15000,
    hstRate: "0.130000",
  };
}

export async function makeCart(): Promise<{ id: string; token: string }> {
  const token = cartToken();
  const cart = await db.cart.create({
    data: { token, status: "ACTIVE" },
    select: { id: true, token: true },
  });
  return cart;
}

export const validAddress = {
  firstName: "Dana",
  lastName: "Kim",
  line1: "10 Dojang Rd",
  city: "Toronto",
  province: "ON" as const,
  postalCode: "M5V 2T6",
  country: "CA" as const,
};

export function placeOrderInput(shippingMethodId: string, over?: Partial<Record<string, unknown>>) {
  return {
    email: TEST_ORDER_EMAIL,
    shippingAddress: validAddress,
    shippingMethodId,
    ...over,
  };
}

/** Remove Phase 6 carts + orders + their audit rows. Config rows are left in place. */
export async function cleanupCheckout(): Promise<void> {
  const orders = await db.order.findMany({
    where: { customerEmail: { contains: "phase6" } },
    select: { id: true },
  });
  await db.auditLog.deleteMany({
    where: { action: "order.placed", entityId: { in: orders.map((o) => o.id) } },
  });
  await db.order.deleteMany({ where: { customerEmail: { contains: "phase6" } } });
  await db.cart.deleteMany({ where: { token: { startsWith: TEST_CART_TOKEN_PREFIX } } });
}
