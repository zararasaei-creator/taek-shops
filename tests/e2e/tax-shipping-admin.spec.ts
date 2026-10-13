import { loadEnvFile } from "node:process";
import { randomBytes } from "node:crypto";

import { PrismaClient, UserRole } from "@prisma/client";
import { expect, test } from "@playwright/test";

import { hashPassword } from "@/server/auth/password";
import { loginAs } from "./helpers/login";

/**
 * Phase 11 admin tax/shipping configuration through the real browser UI, against
 * the dedicated e2e server and the isolated `TEST_DATABASE_URL`. Uses its own
 * jurisdiction (`NU`) and a uniquely named zone, so the shared fixture
 * configuration other specs depend on is never edited. Every number typed here is
 * an arbitrary test value, not a business value.
 */

try {
  loadEnvFile(".env");
} catch {
  // Rely on the ambient environment (CI).
}

const RUN = randomBytes(4).toString("hex");
const PASSWORD = "Config-Admin-Pass-2026!";
const ADMIN = `e2e-cfg-${RUN}-admin@taek.local`;
const MANAGER = `e2e-cfg-${RUN}-manager@taek.local`;
const REGION = `E2E Region ${RUN}`;
const ZONE = `zzz-e2e-zone-${RUN}`;

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required — see tests/integration/README.md.");
}
const db = new PrismaClient({ datasourceUrl: testDatabaseUrl });

test.describe.configure({ mode: "serial" });

// The login rate limiter keys on client IP (10 per 15 min) and the whole e2e run
// signs in from one address; a per-run documentation-range IP keeps this spec's
// three sign-ins from being throttled by (or throttling) the other specs.
test.use({
  extraHTTPHeaders: {
    "x-forwarded-for": `203.0.113.${(parseInt(RUN.slice(0, 2), 16) % 250) + 1}`,
  },
});

test.beforeAll(async () => {
  const passwordHash = await hashPassword(PASSWORD);
  for (const [email, role] of [
    [ADMIN, UserRole.ADMIN],
    [MANAGER, UserRole.MANAGER],
  ] as const) {
    await db.user.create({
      data: { email, role, status: "ACTIVE", firstName: "E2E", lastName: role, passwordHash, emailVerifiedAt: new Date() },
    });
  }
});

test.afterAll(async () => {
  const users = await db.user.findMany({ where: { email: { startsWith: `e2e-cfg-${RUN}-` } }, select: { id: true } });
  const regions = await db.taxRegion.findMany({ where: { name: REGION }, select: { id: true } });
  const zones = await db.shippingZone.findMany({ where: { name: ZONE }, select: { id: true } });
  await db.auditLog.deleteMany({
    where: {
      OR: [
        { actorUserId: { in: users.map((u) => u.id) } },
        { entityId: { in: [...regions, ...zones].map((r) => r.id) } },
      ],
    },
  });
  await db.taxRegion.deleteMany({ where: { id: { in: regions.map((r) => r.id) } } });
  await db.shippingZone.deleteMany({ where: { id: { in: zones.map((z) => z.id) } } });
  await db.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await db.$disconnect();
});

test("a MANAGER is denied the tax and shipping configuration pages", async ({ page }) => {
  await loginAs(page, MANAGER, PASSWORD);
  for (const path of ["/admin/settings/tax", "/admin/settings/shipping"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
    await expect(page.getByTestId(/coverage/)).toHaveCount(0);
  }
});

test("an ADMIN configures tax: coverage flags the gap, a blank rate is rejected, a rate is added and edited, and checkout coverage follows", async ({
  page,
}) => {
  await loginAs(page, ADMIN, PASSWORD);
  await page.goto("/admin/settings/tax");
  await expect(page.getByRole("heading", { name: "Tax rates" })).toBeVisible();
  // Percent/CAD units and the new-orders-only rule are stated on the page.
  await expect(page.getByText(/percentages/i).first()).toBeVisible();
  await expect(page.getByText(/new checkouts only/i)).toBeVisible();
  // The gap is explicit: no tax configured means $0.00 tax, and the page says so.
  await expect(page.getByTestId("tax-coverage-NU")).toContainText(/NOT CONFIGURED — \$0\.00 tax charged/);

  // Create the region (the province select has no silent default).
  await page.getByLabel("Region name").last().fill(REGION);
  await page.getByLabel("Applies to").selectOption("NU");
  await page.getByRole("button", { name: "Create region" }).click();
  const region = page.getByTestId("tax-region-NU");
  await expect(region).toBeVisible();

  // A blank rate is refused — no default zero. The browser blocks the empty required
  // field; the server-side check (blank/garbage, covered by the integration tests)
  // is exercised below with a value that passes the browser but is not a percent.
  const addRate = region.locator("form").filter({ has: page.getByRole("button", { name: "Add rate" }) });
  await addRate.getByLabel("Tax name").fill("E2ETAX");
  await addRate.getByRole("button", { name: "Add rate" }).click();
  expect(await addRate.getByLabel("Rate (%)").evaluate((el) => (el as HTMLInputElement).validity.valueMissing)).toBe(true);
  await addRate.getByLabel("Rate (%)").fill("abc");
  await addRate.getByRole("button", { name: "Add rate" }).click();
  await expect(addRate.getByRole("alert")).toContainText(/percent/i);
  expect(await db.taxRate.count({ where: { region: { name: REGION } } })).toBe(0);

  // A valid percent. (The shared admin form resets its uncontrolled fields after a
  // submission, including a rejected one, so the name is typed again.)
  await addRate.getByLabel("Tax name").fill("E2ETAX");
  await addRate.getByLabel("Rate (%)").fill("5");
  await addRate.getByRole("button", { name: "Add rate" }).click();
  await expect(page.getByTestId("tax-coverage-NU")).toContainText("E2ETAX 5%");
  const stored = await db.taxRate.findFirstOrThrow({ where: { region: { name: REGION }, name: "E2ETAX" } });
  expect(stored.rate.toString()).toBe("0.05"); // 5% stored as the exact fraction

  // Edit it.
  const editRate = region.locator("form").filter({ has: page.getByRole("button", { name: "Save rate" }) }).first();
  await editRate.getByLabel("Rate (%)").fill("6.5");
  await editRate.getByRole("button", { name: "Save rate" }).click();
  await expect(page.getByTestId("tax-coverage-NU")).toContainText("E2ETAX 6.5%");

  // Deactivating (not deleting) puts the explicit warning back.
  await editRate.getByRole("checkbox", { name: "Active" }).uncheck();
  await editRate.getByRole("button", { name: "Save rate" }).click();
  await expect(page.getByTestId("tax-coverage-NU")).toContainText(/NOT CONFIGURED/);
  expect(await db.taxRate.count({ where: { id: stored.id } })).toBe(1);

  // Audited, naming the admin.
  expect(await db.auditLog.count({ where: { entityId: stored.id, action: "config.tax_rate.updated" } })).toBe(2);
});

test("an ADMIN configures shipping: a zone, its coverage and a priced method; invalid price refused; checkout coverage follows", async ({
  page,
}) => {
  await loginAs(page, ADMIN, PASSWORD);
  await page.goto("/admin/settings/shipping");
  await expect(page.getByRole("heading", { name: "Shipping methods" })).toBeVisible();
  await expect(page.getByText(/CAD dollars/i).first()).toBeVisible();
  await expect(page.getByText(/means free shipping/i)).toBeVisible();

  await page.getByLabel("Zone name").last().fill(ZONE);
  await page.getByRole("button", { name: "Create zone" }).click();
  const zone = page.getByTestId(`shipping-zone-${ZONE}`);
  await expect(zone).toBeVisible();

  await zone.getByLabel("Province / territory").selectOption("NU");
  await zone.getByRole("button", { name: "Add coverage" }).click();
  await expect(zone.getByRole("listitem").filter({ hasText: "NU" })).toBeVisible();

  const addMethod = zone.locator("form").filter({ has: page.getByRole("button", { name: "Add method" }) });
  await addMethod.getByLabel("Method name").fill("E2E Ground");
  // Blank price → blocked (no accidental free shipping): the browser stops the empty
  // required field, and the server rejects blank too (integration tests).
  await addMethod.getByRole("button", { name: "Add method" }).click();
  expect(await addMethod.getByLabel("Price (CAD $)").evaluate((el) => (el as HTMLInputElement).validity.valueMissing)).toBe(true);
  // Nonsense price → refused.
  await addMethod.getByLabel("Price (CAD $)").fill("ten");
  await addMethod.getByRole("button", { name: "Add method" }).click();
  await expect(addMethod.getByRole("alert")).toContainText(/CAD dollars/i);
  expect(await db.shippingMethod.count({ where: { zone: { name: ZONE } } })).toBe(0);

  await addMethod.getByLabel("Method name").fill("E2E Ground"); // the form reset after the rejection
  await addMethod.getByLabel("Price (CAD $)").fill("8.25");
  await addMethod.getByRole("button", { name: "Add method" }).click();
  await expect(page.getByTestId("shipping-coverage-NU")).toContainText("E2E Ground $8.25");
  const method = await db.shippingMethod.findFirstOrThrow({ where: { zone: { name: ZONE }, name: "E2E Ground" } });
  expect(method.flatRateCents).toBe(825);

  // Deactivate, not delete.
  const edit = zone.locator("form").filter({ has: page.getByRole("button", { name: "Save method" }) }).first();
  await edit.getByRole("checkbox", { name: "Active" }).uncheck();
  await edit.getByRole("button", { name: "Save method" }).click();
  await expect(page.getByTestId("shipping-coverage-NU")).not.toContainText("E2E Ground");
  expect(await db.shippingMethod.count({ where: { id: method.id } })).toBe(1);
});
