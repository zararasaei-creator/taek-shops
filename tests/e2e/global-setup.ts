import { loadEnvFile } from "node:process";

import { PrismaClient, StockMovementType, UserRole } from "@prisma/client";

import { hashPassword } from "@/server/auth/password";
import {
  authSessionEmail,
  generateAndPersistRunId,
  PHASE8_PASSWORD,
  phase8Emails,
  phase8Orders,
  removePersistedRunId,
} from "./helpers/phase8-fixtures";
import {
  ORDER_HISTORY_PASSWORD,
  orderHistoryEmails,
  orderHistoryOrders,
} from "./helpers/order-history-fixtures";

/**
 * E2E global setup.
 *
 * Isolation (fixed): this run's database is `TEST_DATABASE_URL`, never the
 * application's own `DATABASE_URL` — verified below by a **live** connection
 * that reads Postgres's own `current_database()`, mirroring
 * `tests/integration/helpers/setup.ts`'s fail-closed check. This module
 * fails closed: if isolation cannot be proven, nothing runs. Every
 * `PrismaClient` this file constructs is pointed at the verified test
 * database explicitly (`datasourceUrl`), never at ambient `process.env`.
 *
 * Fixtures are split into two groups:
 * - Phase 6/7 checkout fixtures (`zzz-e2e-*` products, the fixed
 *   `buyer.e2e@taek.local` buyer) — unchanged from before, now simply
 *   pointed at the isolated database instead of the application's.
 * - Phase 8 admin-order fixtures (`tests/e2e/helpers/phase8-fixtures.ts`) —
 *   uniquely identified per run and cleaned up by exact id, not a
 *   shared/reused identifier, so two runs (or a leftover from a crashed run)
 *   can never collide or cross-delete each other's rows. The run id is
 *   generated here and persisted to a temp file — see that module's comment
 *   for why (this setup and the spec files run in different processes).
 */

export const E2E_PRODUCT_SLUG = "zzz-e2e-checkout";
export const E2E_SKU = "E2E-CHECKOUT-1";
export const E2E_BUYER_EMAIL = "buyer.e2e@taek.local";

export const E2E_MULTIVARIANT_PRODUCT_SLUG = "zzz-e2e-multivariant";
export const E2E_MULTIVARIANT_SKUS = {
  smallWhite: "E2E-MV-S-WHITE",
  mediumWhite: "E2E-MV-M-WHITE",
  smallBlack: "E2E-MV-S-BLACK",
} as const;

// ---------------------------------------------------------------------------
// Database isolation — fail closed
// ---------------------------------------------------------------------------

function dbNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, "").toLowerCase();
}

async function verifyIsolatedDatabase(appDatabaseUrl: string, testDatabaseUrl: string): Promise<void> {
  if (testDatabaseUrl === appDatabaseUrl) {
    throw new Error("TEST_DATABASE_URL is identical to DATABASE_URL. Refusing to run e2e.");
  }
  const appName = dbNameOf(appDatabaseUrl);
  const testName = dbNameOf(testDatabaseUrl);
  if (appName === testName) {
    throw new Error(
      `TEST_DATABASE_URL resolves to the same database name ("${testName}") as DATABASE_URL. ` +
        "Refusing to run e2e.",
    );
  }

  // Live proof, not just string parsing — connect to TEST_DATABASE_URL and
  // have Postgres itself report what it resolved to.
  const probe = new PrismaClient({ datasourceUrl: testDatabaseUrl });
  try {
    const rows =
      await probe.$queryRawUnsafe<{ current_database: string }[]>("SELECT current_database()");
    const live = rows[0]?.current_database?.toLowerCase();
    if (!live) throw new Error("empty response");
    if (live !== testName) {
      throw new Error(
        `TEST_DATABASE_URL's own database name ("${testName}") does not match what Postgres ` +
          "reports it actually connected to. Refusing to run e2e.",
      );
    }
    if (live === appName) {
      throw new Error(
        "TEST_DATABASE_URL connected to a live database matching DATABASE_URL. Refusing to run e2e.",
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not verify TEST_DATABASE_URL isolation by connecting to it: ${message}`);
  } finally {
    await probe.$disconnect();
  }
}

// ---------------------------------------------------------------------------
// Login-capable test accounts (identifiers: ./helpers/phase8-fixtures.ts) —
// the Phase 8 admin-order trio, plus one dedicated account for
// auth-session.spec.ts (kept separate so the two specs stay decoupled).
// ---------------------------------------------------------------------------

async function createLoginFixtures(db: PrismaClient, runId: string): Promise<void> {
  const emails = phase8Emails(runId);
  const orders = phase8Orders(runId);
  const passwordHash = await hashPassword(PHASE8_PASSWORD);

  await Promise.all([
    db.user.create({
      data: {
        email: emails.customer,
        role: UserRole.CUSTOMER,
        status: "ACTIVE",
        passwordHash,
        firstName: "E2E",
        lastName: "Customer",
      },
    }),
    db.user.create({
      data: {
        email: emails.staff,
        role: UserRole.STAFF,
        status: "ACTIVE",
        passwordHash,
        firstName: "E2E",
        lastName: "Staff",
      },
    }),
    db.user.create({
      data: {
        email: emails.manager,
        role: UserRole.MANAGER,
        status: "ACTIVE",
        passwordHash,
        firstName: "E2E",
        lastName: "Manager",
      },
    }),
    db.user.create({
      data: {
        email: authSessionEmail(runId),
        role: UserRole.MANAGER,
        status: "ACTIVE",
        passwordHash,
        firstName: "E2E",
        lastName: "AuthSession",
      },
    }),
  ]);

  const makeOrder = async (
    fixture: ReturnType<typeof phase8Orders>[keyof ReturnType<typeof phase8Orders>],
    status: "PENDING" | "CONFIRMED" | "COMPLETED",
    paymentStatus: "UNPAID" | "PAID",
  ) => {
    await db.order.create({
      data: {
        orderNumber: fixture.orderNumber,
        customerEmail: fixture.email,
        status,
        paymentStatus,
        fulfillmentStatus: "UNFULFILLED",
        totalCents: fixture.totalCents,
        subtotalCents: fixture.totalCents,
        items: {
          create: {
            sku: `E2E-PF8-${runId}-SKU`,
            productName: "E2E Phase 8 Test Uniform",
            unitPriceCents: fixture.totalCents,
            quantity: 1,
            lineSubtotalCents: fixture.totalCents,
            lineTotalCents: fixture.totalCents,
          },
        },
        addresses: {
          create: {
            type: "SHIPPING",
            firstName: "E2E",
            lastName: "Buyer",
            line1: "1 Test Way",
            city: "Toronto",
            province: "ON",
            postalCode: "M5V 2T6",
            country: "CA",
          },
        },
      },
    });
  };

  await Promise.all([
    makeOrder(orders.confirmed, "CONFIRMED", "PAID"),
    makeOrder(orders.pending, "PENDING", "UNPAID"),
    makeOrder(orders.completed, "COMPLETED", "PAID"),
  ]);
}

/** Delete only rows this run created — matched by the exact emails/order
 * numbers for this run id, never a shared prefix another run might also be
 * using. */
async function cleanupLoginFixtures(db: PrismaClient, runId: string): Promise<void> {
  const emails = [...Object.values(phase8Emails(runId)), authSessionEmail(runId)];
  const orderNumbers = Object.values(phase8Orders(runId)).map((o) => o.orderNumber);

  const users = await db.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  if (users.length > 0) {
    await db.auditLog.deleteMany({ where: { actorUserId: { in: users.map((u) => u.id) } } });
  }
  await db.order.deleteMany({ where: { orderNumber: { in: orderNumbers } } });
  await db.user.deleteMany({ where: { email: { in: emails } } });
}

// ---------------------------------------------------------------------------
// Customer order-history fixtures (identifiers: ./helpers/order-history-fixtures.ts)
// Two customers, each owning exactly one order, plus a third with none.
// ---------------------------------------------------------------------------

async function createOrderHistoryFixtures(db: PrismaClient, runId: string): Promise<void> {
  const emails = orderHistoryEmails(runId);
  const orders = orderHistoryOrders(runId);
  const passwordHash = await hashPassword(ORDER_HISTORY_PASSWORD);

  const [userA, userB] = await Promise.all([
    db.user.create({
      data: {
        email: emails.customerA,
        role: UserRole.CUSTOMER,
        status: "ACTIVE",
        passwordHash,
        firstName: "E2E",
        lastName: "HistoryA",
      },
      select: { id: true },
    }),
    db.user.create({
      data: {
        email: emails.customerB,
        role: UserRole.CUSTOMER,
        status: "ACTIVE",
        passwordHash,
        firstName: "E2E",
        lastName: "HistoryB",
      },
      select: { id: true },
    }),
    db.user.create({
      data: {
        email: emails.customerEmpty,
        role: UserRole.CUSTOMER,
        status: "ACTIVE",
        passwordHash,
        firstName: "E2E",
        lastName: "HistoryEmpty",
      },
    }),
  ]);

  const makeHistoryOrder = async (
    userId: string,
    fixture: { orderNumber: string; totalCents: number },
  ) => {
    await db.order.create({
      data: {
        orderNumber: fixture.orderNumber,
        userId,
        customerEmail: `${fixture.orderNumber.toLowerCase()}@taek.local`,
        status: "CONFIRMED",
        paymentStatus: "PAID",
        fulfillmentStatus: "UNFULFILLED",
        totalCents: fixture.totalCents,
        subtotalCents: fixture.totalCents,
        items: {
          create: {
            sku: `E2E-HIST-${runId}-SKU`,
            productName: "E2E Order History Uniform",
            unitPriceCents: fixture.totalCents,
            quantity: 1,
            lineSubtotalCents: fixture.totalCents,
            lineTotalCents: fixture.totalCents,
          },
        },
        addresses: {
          create: {
            type: "SHIPPING",
            firstName: "E2E",
            lastName: "Buyer",
            line1: "1 Test Way",
            city: "Toronto",
            province: "ON",
            postalCode: "M5V 2T6",
            country: "CA",
          },
        },
      },
    });
  };

  await Promise.all([
    makeHistoryOrder(userA.id, orders.ownedByA),
    makeHistoryOrder(userB.id, orders.ownedByB),
  ]);
}

async function cleanupOrderHistoryFixtures(db: PrismaClient, runId: string): Promise<void> {
  const emails = Object.values(orderHistoryEmails(runId));
  const orderNumbers = Object.values(orderHistoryOrders(runId)).map((o) => o.orderNumber);

  const users = await db.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  if (users.length > 0) {
    await db.auditLog.deleteMany({ where: { actorUserId: { in: users.map((u) => u.id) } } });
  }
  await db.order.deleteMany({ where: { orderNumber: { in: orderNumbers } } });
  await db.user.deleteMany({ where: { email: { in: emails } } });
}

// ---------------------------------------------------------------------------
// Phase 6/7 checkout fixtures — unchanged logic, now run against the
// isolated database instead of the application's.
// ---------------------------------------------------------------------------

async function removeCheckoutFixtures(db: PrismaClient) {
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
  await db.cart.deleteMany({ where: { items: { some: { variantId: { in: variantIds } } } } });
  await db.product.deleteMany({ where: { slug: { startsWith: "zzz-e2e-" } } });
}

async function createCheckoutFixtures(db: PrismaClient): Promise<void> {
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

  const multivariantProduct = await db.product.create({
    data: {
      name: "E2E Multivariant Dobok",
      slug: E2E_MULTIVARIANT_PRODUCT_SLUG,
      status: "ACTIVE",
      active: true,
      taxCategory: "standard",
    },
    select: { id: true },
  });
  const sizeOption = await db.productOption.create({
    data: {
      productId: multivariantProduct.id,
      name: "Size",
      position: 0,
      values: { create: [{ value: "S", position: 0 }, { value: "M", position: 1 }] },
    },
    select: { id: true, values: { orderBy: { position: "asc" } } },
  });
  const colourOption = await db.productOption.create({
    data: {
      productId: multivariantProduct.id,
      name: "Colour",
      position: 1,
      values: { create: [{ value: "White", position: 0 }, { value: "Black", position: 1 }] },
    },
    select: { id: true, values: { orderBy: { position: "asc" } } },
  });
  const [small, medium] = sizeOption.values;
  const [white, black] = colourOption.values;

  async function makeMultivariant(
    sku: string,
    sizeValueId: string,
    colourValueId: string,
    priceCents: number,
  ) {
    const variant2 = await db.productVariant.create({
      data: {
        productId: multivariantProduct.id,
        sku,
        priceCents,
        optionSignature: [sizeValueId, colourValueId].sort().join("|"),
        optionValues: {
          create: [
            { option: { connect: { id: sizeOption.id } }, optionValue: { connect: { id: sizeValueId } } },
            {
              option: { connect: { id: colourOption.id } },
              optionValue: { connect: { id: colourValueId } },
            },
          ],
        },
        inventoryItem: { create: { quantityOnHand: 200, quantityReserved: 0 } },
      },
      select: { id: true, inventoryItem: { select: { id: true } } },
    });
    await db.stockMovement.create({
      data: {
        inventoryItemId: variant2.inventoryItem!.id,
        variantId: variant2.id,
        type: StockMovementType.INITIAL,
        quantityDelta: 200,
        reservedDelta: 0,
        reason: "E2E opening balance",
      },
    });
  }
  await makeMultivariant(E2E_MULTIVARIANT_SKUS.smallWhite, small!.id, white!.id, 3000);
  await makeMultivariant(E2E_MULTIVARIANT_SKUS.mediumWhite, medium!.id, white!.id, 3200);
  await makeMultivariant(E2E_MULTIVARIANT_SKUS.smallBlack, small!.id, black!.id, 3000);
}

// ---------------------------------------------------------------------------

export default async function globalSetup(): Promise<() => Promise<void>> {
  try {
    loadEnvFile(".env");
  } catch {
    /* ambient env */
  }

  const appDatabaseUrl = process.env.DATABASE_URL;
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!appDatabaseUrl) {
    throw new Error("DATABASE_URL is not set — cannot verify e2e database isolation.");
  }
  if (!testDatabaseUrl) {
    throw new Error(
      "E2E requires TEST_DATABASE_URL (see tests/integration/README.md). Refusing to run e2e " +
        "against the application's own DATABASE_URL.",
    );
  }
  await verifyIsolatedDatabase(appDatabaseUrl, testDatabaseUrl);
  console.info("[e2e-setup] Database isolation verified (distinct database name, confirmed live).");

  // Fresh, unique per run — written to a temp file so the worker process
  // running admin-orders.spec.ts derives the identical fixture identifiers
  // (see helpers/phase8-fixtures.ts for why this can't just be a shared
  // module-level constant).
  const runId = generateAndPersistRunId();

  // Every fixture below uses this client, explicit `datasourceUrl` — never
  // ambient `process.env.DATABASE_URL` (which still names the app's own
  // database in *this* process; only the spawned server's env was changed).
  const db = new PrismaClient({ datasourceUrl: testDatabaseUrl, log: ["error"] });
  try {
    await removeCheckoutFixtures(db);
    await createCheckoutFixtures(db);
    await createLoginFixtures(db, runId);
    await createOrderHistoryFixtures(db, runId);
  } finally {
    await db.$disconnect();
  }

  return async () => {
    const teardownDb = new PrismaClient({ datasourceUrl: testDatabaseUrl, log: ["error"] });
    try {
      await removeCheckoutFixtures(teardownDb);
      await cleanupLoginFixtures(teardownDb, runId);
      await cleanupOrderHistoryFixtures(teardownDb, runId);
    } finally {
      await teardownDb.$disconnect();
      removePersistedRunId();
    }
  };
}
