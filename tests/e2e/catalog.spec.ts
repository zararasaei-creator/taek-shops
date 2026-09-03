import { expect, test } from "@playwright/test";

/**
 * Phase 4 catalogue checks that do not require a database. Full admin CRUD and
 * import round-trips are covered by unit tests (mocked Prisma) until a live
 * PostgreSQL instance is wired for e2e.
 */

test("unauthenticated /admin/catalog redirects to /login", async ({ page }) => {
  await page.goto("/admin/catalog");
  await expect(page).toHaveURL(/\/login/);
});

test("catalog product API requires authentication", async ({ request }) => {
  const response = await request.get("/api/admin/catalog/products");
  expect(response.status()).toBe(401);
  expect((await response.json()).error.code).toBe("unauthenticated");
});

test("inventory adjust API requires authentication + CSRF", async ({ request }) => {
  const noCsrf = await request.post("/api/admin/inventory/adjust", {
    headers: { origin: "http://localhost:3000", "content-type": "application/json" },
    data: { sku: "ABC-1", delta: 1, reason: "x" },
  });
  expect(noCsrf.status()).toBe(403); // guardMutation runs first
});

test("import template download requires authentication", async ({ request }) => {
  const response = await request.get("/api/admin/import/products/template");
  expect(response.status()).toBe(401);
});

test("inventory health endpoint requires authentication", async ({ request }) => {
  const response = await request.get("/api/admin/inventory/health");
  expect(response.status()).toBe(401);
  expect((await response.json()).error.code).toBe("unauthenticated");
});

test("media route rejects path traversal", async ({ request }) => {
  const response = await request.get("/api/media/..%2f..%2fpackage.json");
  expect([400, 404]).toContain(response.status());
});
