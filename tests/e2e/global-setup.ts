import { loadEnvFile } from "node:process";

import { PrismaClient, StockMovementType } from "@prisma/client";

/**
 * E2E global setup (Phase 6).
 *
 * The storefront now reads the database (product grid, cart, checkout), so the
 * e2e run needs a reachable PostgreSQL — start it with
 * `docker compose up -d && npm run db:deploy && npm run db:seed`.
 *
 * This seeds an **isolated** checkout fixture (`zzz-e2e-checkout` product, plenty
 * of stock) plus the example Ontario/HST + Canada/Standard config, and returns a
 * teardown that removes the fixture, e2e carts and e2e orders. Real seed data is
 * never touched.
 */

export const E2E_PRODUCT_SLUG = "zzz-e2e-checkout";
export const E2E_SKU = "E2E-CHECKOUT-1";
export const E2E_BUYER_EMAIL = "buyer.e2e@taek.local";

async function removeFixtures(db: PrismaClient) {
  const products = await db.product.findMany({
    where: { slug: { startsWith: "zzz-e2e-" } },
    select: { variants: { select: { id: true } } },
  });
  const variantIds = products.flatMap((p) => p.variants.map((v) => v.id));

  const orders = await db.order.findMany({
    where: { customerEmail: E2E_BUYER_EMAIL },
    select: { id: true },
  });
  await db.auditLog.deleteMany({
    where: { action: "order.placed", entityId: { in: orders.map((o) => o.id) } },
  });
  await db.order.deleteMany({ where: { customerEmail: E2E_BUYER_EMAIL } });
  // Carts (active or converted) that hold one of the e2e variants.
  await db.cart.deleteMany({ where: { items: { some: { variantId: { in: variantIds } } } } });
  await db.product.deleteMany({ where: { slug: { startsWith: "zzz-e2e-" } } });
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  try {
    loadEnvFile(".env");
  } catch {
    /* ambient env */
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("E2E needs DATABASE_URL — start Postgres and run `npm run db:deploy`.");
  }

  const db = new PrismaClient({ log: ["error"] });
  try {
    await db.$queryRaw`SELECT 1`;
  } catch (error) {
    await db.$disconnect();
    throw new Error(
      `E2E cannot reach the database at DATABASE_URL. Start it with ` +
        `\`docker compose up -d && npm run db:deploy && npm run db:seed\`.\n${String(error)}`,
    );
  }

  await removeFixtures(db);

  // Ontario / HST + Canada / Standard (same rows the seed uses).
  const region = await db.taxRegion.upsert({
    where: { country_province: { country: "CA", province: "ON" } },
    update: { active: true },
    create: { name: "Ontario", country: "CA", province: "ON" },
  });
  await db.taxRate.upsert({
    where: { regionId_name_taxCategory: { regionId: region.id, name: "HST", taxCategory: "" } },
    update: { rate: "0.130000", active: true },
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
  await db.shippingMethod.upsert({
    where: { zoneId_name: { zoneId: zone.id, name: "Standard" } },
    update: { flatRateCents: 1200, freeShippingThresholdCents: 15000, active: true },
    create: {
      zoneId: zone.id,
      name: "Standard",
      flatRateCents: 1200,
      freeShippingThresholdCents: 15000,
      minDeliveryDays: 3,
      maxDeliveryDays: 7,
    },
  });

  const product = await db.product.create({
    data: {
      name: "E2E Checkout Dobok",
      slug: E2E_PRODUCT_SLUG,
      status: "ACTIVE",
      active: true,
      taxCategory: "standard",
      variants: {
        create: {
          sku: E2E_SKU,
          name: "Standard",
          priceCents: 2500,
          weightGrams: 600,
          optionSignature: "",
          inventoryItem: { create: { quantityOnHand: 500, quantityReserved: 0 } },
        },
      },
    },
    select: { variants: { select: { id: true, inventoryItem: { select: { id: true } } } } },
  });
  const variant = product.variants[0]!;
  await db.stockMovement.create({
    data: {
      inventoryItemId: variant.inventoryItem!.id,
      variantId: variant.id,
      type: StockMovementType.INITIAL,
      quantityDelta: 500,
      reservedDelta: 0,
      reason: "E2E opening balance",
    },
  });

  await db.$disconnect();

  return async () => {
    const teardownDb = new PrismaClient({ log: ["error"] });
    await removeFixtures(teardownDb);
    await teardownDb.$disconnect();
  };
}
