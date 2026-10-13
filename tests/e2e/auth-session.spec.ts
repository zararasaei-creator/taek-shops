import { expect, test } from "@playwright/test";

import { E2E_ORIGIN } from "./helpers/base-url";
import { authSessionEmail, PHASE8_PASSWORD, readPersistedRunId } from "./helpers/phase8-fixtures";

/**
 * Full HTTP sign-in → session → logout loop against the dedicated e2e server
 * + the isolated `TEST_DATABASE_URL`. Signs in as a MANAGER account created
 * only in that database by `global-setup.ts` (`authSessionEmail`, real
 * Argon2id hash via `hashPassword`) — not the `db:seed` admin, which lives in
 * the application's own database and was never reachable here safely.
 *
 * Resolves the Phase 5 pre-work item "add the automated e2e for the
 * authenticated flow"; the same loop was verified manually in the Phase 5
 * pre-flight, and again by the user through the browser in Phase 8.
 */
const email = authSessionEmail(readPersistedRunId());
const password = PHASE8_PASSWORD;

test.describe("authenticated session lifecycle", () => {
  test("sign in, use an admin API, sign out, lose access", async ({ request }) => {
    const origin = E2E_ORIGIN;

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
    expect((await ok.json()).user.email).toBe(email.toLowerCase());

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
