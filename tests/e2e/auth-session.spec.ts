import { expect, test } from "@playwright/test";

/**
 * Full HTTP sign-in → session → logout loop against the running app + a live
 * database. Requires a seeded admin: set `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD`
 * (matching a `db:seed` with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`). Skips
 * cleanly when they are absent so the default suite stays DB-free.
 *
 * Resolves the Phase 5 pre-work item "add the automated e2e for the
 * authenticated flow"; the same loop was verified manually in the Phase 5
 * pre-flight.
 */
const email = process.env.E2E_ADMIN_EMAIL;
const password = process.env.E2E_ADMIN_PASSWORD;

test.describe("authenticated session lifecycle", () => {
  test.skip(!email || !password, "set E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD to run");

  test("sign in, use an admin API, sign out, lose access", async ({ request }) => {
    const origin = "http://localhost:3000";

    const bootstrap = await request.get("/api/auth/session");
    const csrf = (await bootstrap.json()).csrfToken as string;
    expect(csrf.length).toBeGreaterThan(10);

    // pre-login: no access
    expect((await request.get("/api/admin/users")).status()).toBe(401);

    // wrong password is rejected
    const bad = await request.post("/api/auth/login", {
      headers: { origin, "content-type": "application/json", "x-csrf-token": csrf },
      data: { email, password: "definitely-not-the-password" },
    });
    expect(bad.status()).toBe(401);

    // correct password establishes a session
    const ok = await request.post("/api/auth/login", {
      headers: { origin, "content-type": "application/json", "x-csrf-token": csrf },
      data: { email, password },
    });
    expect(ok.ok()).toBeTruthy();
    expect((await ok.json()).user.email).toBe(email!.toLowerCase());

    // session now reports the user, and admin APIs work
    expect((await request.get("/api/auth/session")).ok()).toBeTruthy();
    expect((await (await request.get("/api/auth/session")).json()).user).not.toBeNull();
    expect((await request.get("/api/admin/users")).status()).toBe(200);
    expect((await request.get("/api/admin/inventory/health")).status()).toBeLessThan(500);

    // logout revokes the session
    const out = await request.post("/api/auth/logout", {
      headers: { origin, "x-csrf-token": csrf },
    });
    expect(out.ok()).toBeTruthy();
    expect((await (await request.get("/api/auth/session")).json()).user).toBeNull();
    expect((await request.get("/api/admin/users")).status()).toBe(401);
  });
});
