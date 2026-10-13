import { expect, test } from "@playwright/test";

import { loginAs } from "./helpers/login";
import {
  ORDER_HISTORY_PASSWORD,
  orderHistoryEmails,
  orderHistoryOrders,
} from "./helpers/order-history-fixtures";
import { readPersistedRunId } from "./helpers/phase8-fixtures";

/**
 * Customer order-history ("My orders"), against the dedicated e2e server and
 * isolated database. Real `/login` flow, real test-owned accounts — no
 * fabricated sessions.
 *
 * Deliberately minimises the number of real logins in this file (one per
 * distinct account, related assertions folded into the same test after each
 * login) rather than one login per assertion: the production login rate
 * limiter (`src/server/auth/rate-limit.ts`, 10 attempts / 15 min, keyed
 * partly by IP) is shared by every spec file the e2e run executes against
 * this one server process, and every real login — including the deliberately
 * failing ones the other specs cover — consumes a slot from the same IP
 * bucket. That's a real, correct security control; the fix belongs in the
 * test's login budget, not in weakening it.
 */

const RUN_ID = readPersistedRunId();
const EMAILS = orderHistoryEmails(RUN_ID);
const ORDERS = orderHistoryOrders(RUN_ID);

test.describe.configure({ mode: "serial" });

test("unauthenticated access to /account/orders redirects to /login", async ({ page }) => {
  const response = await page.goto("/account/orders");
  await expect(page).toHaveURL(/\/login\?next=/);
  // Decode rather than assume an exact encoding — robust either way.
  expect(new URL(page.url()).searchParams.get("next")).toBe("/account/orders");
  expect(response?.status()).toBeLessThan(400);
});

test("a customer sees only their own order, its detail is correct, another customer's order 404s, and nav shows the link", async ({
  page,
}) => {
  await loginAs(page, EMAILS.customerA, ORDER_HISTORY_PASSWORD, "/account/orders");

  await expect(page.getByRole("heading", { level: 1, name: "My orders" })).toBeVisible();
  await expect(page.getByRole("link", { name: ORDERS.ownedByA.orderNumber })).toBeVisible();
  await expect(page.getByRole("link", { name: ORDERS.ownedByB.orderNumber })).toHaveCount(0);

  await page.getByRole("link", { name: ORDERS.ownedByA.orderNumber }).click();
  await expect(page.getByTestId("order-number")).toHaveText(ORDERS.ownedByA.orderNumber);
  await expect(page.getByTestId("order-status")).toHaveText("CONFIRMED");
  await expect(page.getByTestId("payment-status")).toHaveText("PAID");
  await expect(page.getByText("E2E Order History Uniform")).toBeVisible();
  await expect(page.getByText("$33.00", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("1 Test Way")).toBeVisible();

  // Cannot open customer B's order by guessing its number — 404, not 403 or
  // its data (no existence leak either way).
  const response = await page.goto(`/account/orders/${ORDERS.ownedByB.orderNumber}`);
  expect(response?.status()).toBe(404);
  await expect(page.getByText("$44.00", { exact: false })).toHaveCount(0);

  // The nav shows "My orders" while this same session is signed in.
  await page.goto("/");
  await expect(page.getByTestId("nav-my-orders")).toBeVisible();
});

test("a customer with no orders sees the empty state", async ({ page }) => {
  await loginAs(page, EMAILS.customerEmpty, ORDER_HISTORY_PASSWORD, "/account/orders");

  await expect(page.getByTestId("orders-empty")).toBeVisible();
  await expect(page.getByTestId("orders-list")).toHaveCount(0);
});
