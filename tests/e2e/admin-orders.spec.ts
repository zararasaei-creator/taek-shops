import { expect, test } from "@playwright/test";

import { loginAs } from "./helpers/login";
import { PHASE8_PASSWORD, phase8Emails, phase8Orders, readPersistedRunId } from "./helpers/phase8-fixtures";

/**
 * Phase 8 admin-order browser coverage, against the dedicated e2e server
 * (localhost:3100) and the isolated TEST_DATABASE_URL — see
 * playwright.config.ts / global-setup.ts. Every login goes through the real
 * `/login` form with a real, freshly-hashed test-only account; no session is
 * fabricated and no role is broadened to make an assertion pass.
 *
 * Fixture identifiers are derived from the run id `global-setup.ts` wrote to
 * a temp file (this file runs in a separate worker process from setup, so it
 * cannot just re-generate its own id — see helpers/phase8-fixtures.ts).
 */

const RUN_ID = readPersistedRunId();
const EMAILS = phase8Emails(RUN_ID);
const ORDERS = phase8Orders(RUN_ID);

test.describe.configure({ mode: "serial" });

// These three were originally separate tests, each re-logging in as the
// same MANAGER account. Consolidated into one test, one login — the shared
// e2e login rate limiter (`src/server/auth/rate-limit.ts`, 10 attempts /
// 15 min, keyed partly by IP) is shared by every spec file the e2e run
// executes against this one server process, and every real login consumes
// a slot from the same IP bucket regardless of which file it's in. Adding
// `product-images.spec.ts`'s one necessary login pushed the whole suite's
// total past that shared budget; per the same fix `customer-order-history.spec.ts`
// already applies (see its own comment), the fix belongs in reducing a
// redundant login budget, never in weakening the limiter itself. Every
// original assertion is unchanged.
test("admin order list (search/filter/sort), order detail, and a status transition — one login", async ({
  page,
}) => {
  await loginAs(page, EMAILS.manager, PHASE8_PASSWORD);

  // Search by this run's unique id — matches all three fixture orders and,
  // by finding them at all, doubles as proof the running server is reading
  // the same (isolated) database this file's global-setup wrote to: they
  // exist nowhere else.
  await page.goto("/admin/orders");
  // Search on `PF8-<runId>`, not the bare run id — the customer
  // order-history fixtures share the same run id and would otherwise also
  // match (their order numbers/emails contain it too), overcounting rows.
  await page.locator('input[name="q"]').fill(`PF8-${RUN_ID}`);
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page.getByRole("link", { name: ORDERS.confirmed.orderNumber })).toBeVisible();
  await expect(page.getByRole("link", { name: ORDERS.pending.orderNumber })).toBeVisible();
  await expect(page.getByRole("link", { name: ORDERS.completed.orderNumber })).toBeVisible();

  // Status filter narrows to exactly the PENDING fixture.
  await page.locator('select[name="status"]').selectOption("PENDING");
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page.getByRole("link", { name: ORDERS.pending.orderNumber })).toBeVisible();
  await expect(page.getByRole("link", { name: ORDERS.confirmed.orderNumber })).toHaveCount(0);
  await expect(page.getByRole("link", { name: ORDERS.completed.orderNumber })).toHaveCount(0);

  // Sort by total ascending, across all three again: pending ($20) <
  // confirmed ($45) < completed ($99).
  await page.locator('select[name="status"]').selectOption("");
  await page.locator('select[name="sort"]').selectOption("total_asc");
  await page.getByRole("button", { name: "Filter" }).click();
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText(ORDERS.pending.orderNumber);
  await expect(rows.nth(1)).toContainText(ORDERS.confirmed.orderNumber);
  await expect(rows.nth(2)).toContainText(ORDERS.completed.orderNumber);

  // Order detail: items, totals, and shipping address render.
  await page.locator('input[name="q"]').fill(ORDERS.completed.orderNumber);
  await page.getByRole("button", { name: "Filter" }).click();
  await page.getByRole("link", { name: ORDERS.completed.orderNumber }).click();

  await expect(page.getByRole("heading", { level: 1, name: ORDERS.completed.orderNumber })).toBeVisible();
  await expect(page.getByText(/COMPLETED\s*·\s*PAID\s*·\s*UNFULFILLED/)).toBeVisible();
  await expect(page.getByText("E2E Phase 8 Test Uniform")).toBeVisible();
  await expect(page.getByText("$99.00", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("1 Test Way")).toBeVisible();

  // Confirmed -> Processing persists after reload (payment status untouched).
  await page.goto("/admin/orders");
  await page.locator('input[name="q"]').fill(ORDERS.confirmed.orderNumber);
  await page.getByRole("button", { name: "Filter" }).click();
  await page.getByRole("link", { name: ORDERS.confirmed.orderNumber }).click();

  await expect(page.getByText(/CONFIRMED\s*·\s*PAID\s*·\s*UNFULFILLED/)).toBeVisible();

  await page.getByRole("button", { name: "Start processing" }).click();
  await expect(page.getByText(/PROCESSING\s*·\s*PAID\s*·\s*UNFULFILLED/)).toBeVisible();

  await page.reload();
  await expect(page.getByText(/PROCESSING\s*·\s*PAID\s*·\s*UNFULFILLED/)).toBeVisible();
});

test("CUSTOMER is denied admin access", async ({ page }) => {
  await loginAs(page, EMAILS.customer, PHASE8_PASSWORD, "/account"); // customers land on their account now

  await page.goto("/admin/orders");
  await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Order" })).toHaveCount(0);
});

test("STAFF can view an order but has no status-change controls", async ({ page }) => {
  await loginAs(page, EMAILS.staff, PHASE8_PASSWORD);

  await page.goto("/admin/orders");
  await page.locator('input[name="q"]').fill(ORDERS.pending.orderNumber);
  await page.getByRole("button", { name: "Filter" }).click();
  await page.getByRole("link", { name: ORDERS.pending.orderNumber }).click();

  await expect(page.getByRole("heading", { level: 1, name: ORDERS.pending.orderNumber })).toBeVisible();
  // A MANAGER viewing this PENDING order would see "Cancel order"; STAFF
  // (order.read only) must see none of the status-change controls.
  await expect(page.getByRole("button", { name: "Cancel order" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start processing" })).toHaveCount(0);
});
