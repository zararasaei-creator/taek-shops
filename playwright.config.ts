import { loadEnvFile } from "node:process";
import { defineConfig, devices } from "@playwright/test";

import { E2E_ORIGIN } from "./tests/e2e/helpers/base-url";

/**
 * E2E isolation (fixed — see docs/implementation-roadmap.md Phase 8).
 *
 * This suite now runs its own dedicated server on its own port against its
 * own database, never the developer's `localhost:3000` / `DATABASE_URL`:
 *
 * - Port 3100, never 3000. `reuseExistingServer: false` always (even
 *   locally) — if 3100 is already in use, `next start` fails to bind and
 *   Playwright reports a clear timeout instead of silently reusing whatever
 *   is listening there. Nothing here ever kills another process.
 * - `TEST_DATABASE_URL` (the same isolated database the integration suite
 *   uses) is required and verified distinct from `DATABASE_URL` by database
 *   NAME (a shared host/port is not proof of isolation) before anything
 *   runs. The resolved URL is then passed explicitly into the spawned
 *   server's `env`, which — per Node's `child_process` semantics — is that
 *   process's `process.env` from the instant it starts, before Next's own
 *   `.env` loading (which never overrides an already-set key) ever runs.
 *   `tests/e2e/global-setup.ts` independently re-verifies this by making a
 *   live connection and reading Postgres's own `current_database()`, and the
 *   first spec asserts the *running server* actually sees a fixture that
 *   only exists in the test database — proof of routing, not just of
 *   configuration.
 * - A separate `distDir` (`next.config.ts` reads `E2E_DIST_DIR`) so this
 *   run's `next build` never writes into the `.next` a concurrently-running
 *   `next dev` is using.
 */

try {
  loadEnvFile(".env");
} catch {
  // No .env — rely on the ambient environment (CI).
}

const baseURL = E2E_ORIGIN;
const E2E_PORT = new URL(baseURL).port;
const E2E_DIST_DIR = ".next-e2e";

function dbNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, "").toLowerCase();
}

function requireIsolatedE2eDatabase(): string {
  const appDatabaseUrl = process.env.DATABASE_URL;
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;

  if (!appDatabaseUrl) {
    throw new Error("DATABASE_URL is not set — cannot verify e2e database isolation.");
  }
  if (!testDatabaseUrl) {
    throw new Error(
      "E2E requires TEST_DATABASE_URL — the same isolated database the integration suite uses " +
        "(see tests/integration/README.md). Refusing to run e2e against the application's own " +
        "DATABASE_URL.",
    );
  }
  if (testDatabaseUrl === appDatabaseUrl) {
    throw new Error("TEST_DATABASE_URL is identical to DATABASE_URL. Refusing to run e2e.");
  }

  let appName: string;
  let testName: string;
  try {
    appName = dbNameOf(appDatabaseUrl);
    testName = dbNameOf(testDatabaseUrl);
  } catch {
    throw new Error("Could not parse DATABASE_URL / TEST_DATABASE_URL. Refusing to run e2e.");
  }
  if (appName === testName) {
    throw new Error(
      `TEST_DATABASE_URL resolves to the same database name ("${testName}") as DATABASE_URL. ` +
        "A different host/hostname alone is not proof of isolation. Refusing to run e2e.",
    );
  }

  // This is the static, synchronous half of the check (safe to run at config
  // load, no I/O). The live half — actually connecting and confirming
  // Postgres's own current_database() — runs in tests/e2e/global-setup.ts,
  // which throws (aborting the whole run before any test executes) if it
  // disagrees with what's checked here.
  return testDatabaseUrl;
}

const e2eDatabaseUrl = requireIsolatedE2eDatabase();

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  // Serial: fixtures (orders, users) are shared within a run and several
  // specs mutate real rows (status transitions) — never run concurrently
  // against them.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run build && npm run start",
    url: baseURL,
    // Always a fresh, dedicated instance — never the developer's dev server,
    // even locally.
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      PORT: String(E2E_PORT),
      DATABASE_URL: e2eDatabaseUrl,
      E2E_DIST_DIR,
      NEXT_PUBLIC_APP_URL: baseURL,
      // Stripe keys are left to whatever `.env` provides (this project only
      // ever configures TEST-mode keys — verified earlier). Not overridden
      // here: `serverEnv`'s schema requires an unset key to be genuinely
      // absent, not empty, and most Phase 8 specs never exercise a payment
      // code path regardless.
      //
      // `admin-refund.spec.ts` DOES exercise the refund flow through this
      // server — `PAYMENT_GATEWAY=e2e-fake` swaps in a deterministic double
      // (`src/server/domain/payments/e2e-fake-gateway.ts`) for this
      // process ONLY, so it never reaches real Stripe even if TEST-mode
      // keys are configured. Never set for `next dev`/`next start`/CI
      // production. `src/server/domain/payments/index.ts`'s
      // `getPaymentGateway()` independently requires E2E_DIST_DIR to be
      // exactly ".next-e2e" AND DATABASE_URL to equal TEST_DATABASE_URL
      // (inherited from this process's own env, not just the two vars set
      // here) before it will honour this — keep that literal in sync with
      // E2E_DIST_DIR above if it ever changes.
      PAYMENT_GATEWAY: "e2e-fake",
      // Product images (Phase 9): force the local-filesystem storage
      // backend for this process, pointed at its own dedicated,
      // `.gitignore`'d directory — never `storage/objects` (the dev
      // server's own local backend, when Docker/MinIO isn't running) and
      // never real MinIO. Explicitly blank out every S3_* var so this
      // process never picks up whatever `.env` configures for local dev
      // MinIO (Playwright's `env` merges with, rather than replaces, the
      // inherited environment — an unset override here would leak the
      // ambient S3_* config straight through). Isolation by construction:
      // e2e-uploaded test images can never land in, or be cleaned up from,
      // real dev-local storage.
      LOCAL_STORAGE_ROOT: ".e2e-storage-objects",
      S3_ENDPOINT: "",
      S3_REGION: "",
      S3_BUCKET: "",
      S3_ACCESS_KEY_ID: "",
      S3_SECRET_ACCESS_KEY: "",
      S3_PUBLIC_BASE_URL: "",
      // Email (real provider, launch-prep milestone): force the local
      // preview transport for this process, never the real Resend one,
      // even if `.env` configures real credentials for local dev. This
      // process runs `npm run build && npm run start`
      // (`NODE_ENV=production`), so `resolveEmailTransport()`'s own
      // test-run check (`NODE_ENV=test`/`VITEST`) does NOT catch it — this
      // explicit override is the actual defense here, the same role
      // `PAYMENT_GATEWAY=e2e-fake` and the blanked S3_* vars above already
      // play for their own providers. Any e2e spec that exercises a real
      // payment success or a fulfilment change (triggering
      // `kickEmailDispatch`) writes a harmless local preview file under
      // the same `.local/email-previews/` directory dev already uses
      // (not itself isolated per-run — these are inert, gitignored files,
      // unlike the S3 storage case above where a key collision would be a
      // correctness bug) instead of ever reaching Resend.
      EMAIL_TRANSPORT: "local-preview",
      RESEND_API_KEY: "",
      EMAIL_FROM_ADDRESS: "",
    },
  },
});
