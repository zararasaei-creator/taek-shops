import { expect, test } from "@playwright/test";

/**
 * Phase 3 auth checks that do not require a database. Full sign-in flows are
 * covered by unit tests (mocked Prisma) until a live Postgres is wired for e2e.
 */

test("unauthenticated /admin redirects to /login", async ({ page }) => {
  const response = await page.goto("/admin");
  await expect(page).toHaveURL(/\/login\?next=%2Fadmin/);
  expect(response?.status()).toBeLessThan(400);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
});

test("login page renders an accessible credentials form", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("security headers are present", async ({ request }) => {
  const response = await request.get("/");
  const headers = response.headers();
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["content-security-policy"]).toContain("default-src 'self'");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["permissions-policy"]).toContain("geolocation=()");
});

test("session endpoint issues a CSRF token and reports no user", async ({ request }) => {
  const response = await request.get("/api/auth/session");
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.user).toBeNull();
  expect(typeof body.csrfToken).toBe("string");
  expect(body.csrfToken.length).toBeGreaterThan(10);
});

test("admin API rejects unauthenticated access with 401", async ({ request }) => {
  const response = await request.get("/api/admin/users");
  expect(response.status()).toBe(401);
  const body = await response.json();
  expect(body.error.code).toBe("unauthenticated");
});

test("login rejects a request with no CSRF token", async ({ request }) => {
  const response = await request.post("/api/auth/login", {
    headers: { origin: "http://localhost:3000", "content-type": "application/json" },
    data: { email: "someone@example.com", password: "whatever-value" },
  });
  expect(response.status()).toBe(403);
});
