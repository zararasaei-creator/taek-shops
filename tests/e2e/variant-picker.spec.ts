import { expect, test } from "@playwright/test";

import { E2E_MULTIVARIANT_PRODUCT_SLUG, E2E_MULTIVARIANT_SKUS } from "./global-setup";

/**
 * Storefront option-based variant picker (catalog/variant pre-work). The
 * product page must resolve Size x Colour selections to a single real variant
 * id and hand it, unchanged, to the existing add-to-cart action.
 */

test("resolves option selections to the correct variant and adds it to the cart", async ({
  page,
}) => {
  await page.goto(`/products/${E2E_MULTIVARIANT_PRODUCT_SLUG}`);

  const picker = page.getByTestId("variant-picker");
  await expect(picker).toBeVisible();

  // Default selection (first variant: Small / White).
  await expect(page.getByTestId("variant-picker-price")).toContainText(
    E2E_MULTIVARIANT_SKUS.smallWhite,
  );

  // Switch to Medium — still White — resolves to the Medium/White variant.
  await page.getByTestId("variant-option-Size-M").click();
  await expect(page.getByTestId("variant-picker-price")).toContainText(
    E2E_MULTIVARIANT_SKUS.mediumWhite,
  );

  // Switch to Black — no Medium/Black variant exists, so the combination is
  // reported unavailable and "Add to cart" is disabled.
  await page.getByTestId("variant-option-Colour-Black").click();
  await expect(page.getByText("This combination isn't available.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add to cart" })).toBeDisabled();

  // Back to Small — Small/Black does exist.
  await page.getByTestId("variant-option-Size-S").click();
  await expect(page.getByTestId("variant-picker-price")).toContainText(
    E2E_MULTIVARIANT_SKUS.smallBlack,
  );

  await page.getByRole("button", { name: "Add to cart" }).click();
  await expect(page.getByTestId("nav-cart")).toHaveText("Cart (1)");
  await page.goto("/cart");
  await expect(page.getByTestId("cart-lines")).toContainText("Size: S");
  await expect(page.getByTestId("cart-lines")).toContainText("Colour: Black");
});
