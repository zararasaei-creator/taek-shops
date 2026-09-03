import { expect, test } from "@playwright/test";

import { E2E_BUYER_EMAIL, E2E_PRODUCT_SLUG } from "./global-setup";

/**
 * Phase 6 acceptance: cart → checkout → order in a pending state.
 * Runs against the running app + live PostgreSQL (see global-setup.ts).
 */
test("a shopper can browse, add to cart, check out, and reach a pending order", async ({
  page,
}) => {
  // 1. Storefront → product
  await page.goto(`/products/${E2E_PRODUCT_SLUG}`);
  await expect(page.getByRole("heading", { level: 1, name: "E2E Checkout Dobok" })).toBeVisible();

  // 2. Add to cart (two units) — one row, submit twice
  const addButton = page.getByRole("button", { name: "Add to cart" }).first();
  await addButton.click();
  await expect(page.getByTestId("nav-cart")).toHaveText("Cart (1)");
  await page.goto(`/products/${E2E_PRODUCT_SLUG}`);
  await page.getByRole("button", { name: "Add to cart" }).first().click();
  await expect(page.getByTestId("nav-cart")).toHaveText("Cart (2)");

  // 3. Cart shows the line + subtotal (2 × $25.00)
  await page.goto("/cart");
  await expect(page.getByTestId("cart-subtotal")).toHaveText("$50.00");
  await page.getByTestId("to-checkout").click();

  // 4. Checkout — contact + address + shipping method
  await expect(page).toHaveURL(/\/checkout$/);
  await page.locator('input[name="email"]').fill(E2E_BUYER_EMAIL);
  await page.locator('input[name="firstName"]').fill("Dana");
  await page.locator('input[name="lastName"]').fill("Kim");
  await page.locator('input[name="line1"]').fill("10 Dojang Rd");
  await page.locator('input[name="city"]').fill("Toronto");
  await page.locator('select[name="province"]').selectOption("ON");
  await page.locator('input[name="postalCode"]').fill("M5V 2T6");
  await page.getByRole("radio").first().check();

  // review reflects server-computed shipping + HST
  await expect(page.getByTestId("review-subtotal")).toHaveText("$50.00");
  await expect(page.getByTestId("review-shipping")).toHaveText("$12.00");
  await expect(page.getByTestId("review-tax")).toHaveText("$6.50"); // 13% of $50
  await expect(page.getByTestId("review-total")).toHaveText("$68.50");

  // 5. Place the order
  await page.getByRole("button", { name: "Place order" }).click();

  // 6. Confirmation — pending order with a number
  await expect(page).toHaveURL(/\/checkout\/confirmation\/TS-/);
  await expect(page.getByTestId("order-status")).toHaveText(/pending/i);
  const orderNumber = await page.getByTestId("order-number").textContent();
  expect(orderNumber).toMatch(/^TS-\d{8}-[0-9A-Z]{6}$/);

  // cart is emptied
  await page.goto("/cart");
  await expect(page.getByTestId("cart-empty")).toBeVisible();
});

test("checkout redirects to the cart when the cart is empty", async ({ page }) => {
  await page.goto("/checkout");
  await expect(page).toHaveURL(/\/cart$/);
});
