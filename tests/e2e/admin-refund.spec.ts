import { loadEnvFile } from "node:process";
import { randomBytes } from "node:crypto";

import { PrismaClient, UserRole } from "@prisma/client";
import { expect, test } from "@playwright/test";

import { hashPassword } from "@/server/auth/password";
import { loginAs } from "./helpers/login";

/**
 * Phase 8 admin refund — browser coverage against the dedicated e2e server
 * (localhost:3100, `PAYMENT_GATEWAY=e2e-fake` — see playwright.config.ts) and
 * the isolated `TEST_DATABASE_URL`. Login goes through the real `/login`
 * form with a real, freshly-hashed test-only account; no session is
 * fabricated. The refund itself is settled by a deterministic, always-
 * succeeds double (`E2EFakePaymentGateway`), never real Stripe — this proves
 * the admin UI -> server action -> `refund-service.ts` -> `PaymentGateway`
 * wiring, not real Stripe refund behaviour.
 *
 * Self-contained: creates and tears down its own fixtures (a dedicated
 * MANAGER account + one paid order + Payment row), independent of
 * `global-setup.ts` / `phase8-fixtures.ts`, so it never shares — and can
 * never disturb — the fixtures `admin-orders.spec.ts` mutates.
 */

try {
  loadEnvFile(".env");
} catch {
  // Rely on the ambient environment (CI).
}

const RUN_ID = randomBytes(4).toString("hex");
const MANAGER_EMAIL = `e2e-refund-manager-${RUN_ID}@taek.local`;
const PASSWORD = "Refund-Verify-2026!";
const ORDER_NUMBER = `E2E-REFUND-${RUN_ID}`;

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required — see tests/integration/README.md.");
}
const db = new PrismaClient({ datasourceUrl: testDatabaseUrl });

let orderId: string;

test.beforeAll(async () => {
  const passwordHash = await hashPassword(PASSWORD);
  await db.user.create({
    data: {
      email: MANAGER_EMAIL,
      role: UserRole.MANAGER,
      status: "ACTIVE",
      firstName: "E2E",
      lastName: "Refund Manager",
      emailVerifiedAt: new Date(),
      passwordHash,
    },
  });

  const order = await db.order.create({
    data: {
      orderNumber: ORDER_NUMBER,
      customerEmail: `e2e-refund-buyer-${RUN_ID}@taek.local`,
      status: "CONFIRMED",
      paymentStatus: "PAID",
      totalCents: 4000,
      items: {
        create: {
          sku: `E2E-REFUND-SKU-${RUN_ID}`,
          productName: "E2E Refund Test Item",
          unitPriceCents: 4000,
          quantity: 1,
          lineSubtotalCents: 4000,
          lineTotalCents: 4000,
        },
      },
      payments: {
        create: {
          provider: "stripe",
          providerPaymentId: `pi_e2e_${RUN_ID}`,
          status: "CAPTURED",
          amountCents: 4000,
        },
      },
    },
    select: { id: true },
  });
  orderId = order.id;
});

test.afterAll(async () => {
  await db.auditLog.deleteMany({ where: { entityType: "Order", entityId: orderId } });
  await db.order.deleteMany({ where: { orderNumber: ORDER_NUMBER } });
  await db.user.deleteMany({ where: { email: MANAGER_EMAIL } });
  await db.$disconnect();
});

test("a MANAGER can request a partial refund through the admin UI and see it settle", async ({
  page,
}) => {
  await loginAs(page, MANAGER_EMAIL, PASSWORD);

  await page.goto(`/admin/orders/${orderId}`);
  await expect(page.getByRole("heading", { level: 1, name: ORDER_NUMBER })).toBeVisible();

  // Before: full balance refundable, nothing refunded yet.
  await expect(page.getByText("No refunds requested yet.")).toBeVisible();

  await page.getByPlaceholder("40.00").fill("15.00");
  await page.getByPlaceholder("Customer returned the item").fill("e2e partial refund");
  await page.getByRole("checkbox", { name: /I confirm this refund/ }).check();
  await page.getByRole("button", { name: "Request refund" }).click();

  await expect(page.getByText("Refund requested.")).toBeVisible();
  // The e2e-fake gateway settles immediately: SUCCEEDED, not PENDING.
  await expect(page.getByText("SUCCEEDED")).toBeVisible();
  await expect(page.getByText("e2e partial refund")).toBeVisible();

  // Reload — persisted, not just client-side optimism.
  await page.reload();
  await expect(page.getByText("SUCCEEDED")).toBeVisible();
  await expect(page.getByText(/\$15\.00/).first()).toBeVisible(); // pending/confirmed-refunded figure
  await expect(page.getByText(/\$25\.00/).first()).toBeVisible(); // remaining refundable

  const payment = await db.payment.findFirstOrThrow({ where: { orderId } });
  expect(payment.refundedCents).toBe(1500);
  expect(payment.status).toBe("PARTIALLY_REFUNDED");
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  expect(order.paymentStatus).toBe("PARTIALLY_REFUNDED");
  expect(order.status).toBe("CONFIRMED"); // OrderStatus untouched by a refund
});
