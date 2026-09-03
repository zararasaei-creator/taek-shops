import { StockMovementType, UserRole, type OrderStatus } from "@prisma/client";

import { prisma } from "@/server/db/client";

/**
 * Shared helpers for the Phase 5 database-backed integration tests.
 *
 * Every fixture row this creates is namespaced so cleanup is exact and can never
 * touch real / seed data:
 *   - products : slug starts `zzz-phase5-`
 *   - variants : sku   starts `PF5-`
 *   - orders   : orderNumber starts `PF5-ORD-`
 *   - actor    : the single user `phase5-tests@taek.local`
 */

export const TEST_PRODUCT_SLUG_PREFIX = "zzz-phase5-";
export const TEST_SKU_PREFIX = "PF5-";
export const TEST_ORDER_PREFIX = "PF5-ORD-";
const TEST_ACTOR_EMAIL = "phase5-tests@taek.local";

/**
 * The same shared client the services use. `helpers/setup.ts` has already
 * widened its connection pool (see the note there) before this import ran.
 */
export const db = prisma;

let rand = 0;
function uid(): string {
  rand += 1;
  return `${Date.now().toString(36)}${rand}`;
}

export interface TestActor {
  id: string;
  role: UserRole;
}

/** Idempotently ensure the manager-level actor the services authorize against. */
export async function ensureActor(): Promise<TestActor> {
  const user = await db.user.upsert({
    where: { email: TEST_ACTOR_EMAIL },
    update: { role: UserRole.MANAGER, status: "ACTIVE" },
    create: {
      email: TEST_ACTOR_EMAIL,
      role: UserRole.MANAGER,
      status: "ACTIVE",
      firstName: "Phase5",
      lastName: "Tests",
    },
    select: { id: true, role: true },
  });
  return user;
}

export interface TestVariant {
  productId: string;
  variantId: string;
  inventoryItemId: string;
  sku: string;
}

/** Create a throwaway product + one variant + its inventory item. */
export async function makeVariant(
  opts: { onHand?: number; reserved?: number } = {},
): Promise<TestVariant> {
  const onHand = opts.onHand ?? 0;
  const reserved = opts.reserved ?? 0;
  const suffix = uid();
  const sku = `${TEST_SKU_PREFIX}${suffix}`;

  const product = await db.product.create({
    data: {
      name: `Phase 5 Test ${suffix}`,
      slug: `${TEST_PRODUCT_SLUG_PREFIX}${suffix}`,
      status: "ACTIVE",
      active: true,
      variants: {
        create: {
          sku,
          priceCents: 1000,
          optionSignature: "",
          inventoryItem: { create: { quantityOnHand: onHand, quantityReserved: reserved } },
        },
      },
    },
    select: {
      id: true,
      variants: { select: { id: true, inventoryItem: { select: { id: true } } } },
    },
  });

  const variant = product.variants[0]!;
  const testVariant: TestVariant = {
    productId: product.id,
    variantId: variant.id,
    inventoryItemId: variant.inventoryItem!.id,
    sku,
  };

  // An opening-balance movement so the ledger reconciles from the start
  // (quantityOnHand == SUM(quantityDelta)).
  if (onHand !== 0) {
    await db.stockMovement.create({
      data: {
        inventoryItemId: testVariant.inventoryItemId,
        variantId: testVariant.variantId,
        type: StockMovementType.INITIAL,
        quantityDelta: onHand,
        reservedDelta: 0,
        reason: "Test opening balance",
      },
    });
  }
  return testVariant;
}

/** Create a throwaway PENDING order with the given lines. */
export async function makeOrder(
  lines: { variantId: string; quantity: number; sku: string }[],
  status: OrderStatus = "PENDING",
): Promise<{ orderId: string; orderNumber: string }> {
  const orderNumber = `${TEST_ORDER_PREFIX}${uid()}`;
  const order = await db.order.create({
    data: {
      orderNumber,
      customerEmail: "phase5-order@taek.local",
      status,
      items: {
        create: lines.map((l) => ({
          variantId: l.variantId,
          sku: l.sku,
          productName: "Phase 5 Test",
          unitPriceCents: 1000,
          quantity: l.quantity,
          lineSubtotalCents: 1000 * l.quantity,
          lineTotalCents: 1000 * l.quantity,
        })),
      },
    },
    select: { id: true, orderNumber: true },
  });
  return { orderId: order.id, orderNumber: order.orderNumber };
}

/** afterAll: delete this file's fixtures, then drop the connection. */
export async function teardown(): Promise<void> {
  await cleanup();
  await db.$disconnect();
}

export async function readItem(inventoryItemId: string) {
  return db.inventoryItem.findUniqueOrThrow({
    where: { id: inventoryItemId },
    select: { quantityOnHand: true, quantityReserved: true },
  });
}

export async function ledgerSums(inventoryItemId: string): Promise<{
  onHand: number;
  reserved: number;
  count: number;
}> {
  const agg = await db.stockMovement.aggregate({
    where: { inventoryItemId },
    _sum: { quantityDelta: true, reservedDelta: true },
    _count: true,
  });
  return {
    onHand: agg._sum.quantityDelta ?? 0,
    reserved: agg._sum.reservedDelta ?? 0,
    count: agg._count,
  };
}

/** Remove every namespaced fixture row. Call in afterAll. */
export async function cleanup(): Promise<void> {
  const actor = await db.user.findUnique({
    where: { email: TEST_ACTOR_EMAIL },
    select: { id: true },
  });
  if (actor) {
    await db.auditLog.deleteMany({ where: { actorUserId: actor.id } });
  }
  await db.order.deleteMany({ where: { orderNumber: { startsWith: TEST_ORDER_PREFIX } } });
  // Deleting the product cascades to variant -> inventory item -> stock movements.
  await db.product.deleteMany({ where: { slug: { startsWith: TEST_PRODUCT_SLUG_PREFIX } } });
  await db.user.deleteMany({ where: { email: TEST_ACTOR_EMAIL } });
}
