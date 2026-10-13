import { StripePaymentGateway } from "@/server/domain/payments/stripe";
import { E2EFakePaymentGateway } from "@/server/domain/payments/e2e-fake-gateway";
import type { PaymentGateway } from "@/server/domain/payments/payment-gateway";

export * from "@/server/domain/payments/payment-gateway";

let gateway: PaymentGateway | null = null;

/**
 * The exact `E2E_DIST_DIR` value `playwright.config.ts` sets for its
 * dedicated e2e server (and `next.config.ts` reads to give that run its own
 * build output directory). Duplicated here as a literal — rather than
 * imported — because `playwright.config.ts` runs under Playwright's own
 * config loader, a different module-resolution context than the Next.js
 * app; importing across that boundary is a fragile way to share one string.
 * If the harness's value ever changes, this constant must change with it.
 */
const E2E_DIST_DIR_MARKER = ".next-e2e";

/**
 * The active payment gateway. Swap point for a different provider.
 *
 * `PAYMENT_GATEWAY=e2e-fake` selects a deterministic, never-calls-Stripe
 * double — set ONLY by `playwright.config.ts` for its own dedicated e2e
 * server process (`tests/e2e/admin-refund.spec.ts`). Activating it requires
 * BOTH of the following, checked independently right here, or this throws
 * immediately — before any gateway (real or fake) is constructed and before
 * any payment action can run:
 *
 * 1. `E2E_DIST_DIR === ".next-e2e"` (exact match, not merely truthy) — that
 *    process's `next build && next start` forces `NODE_ENV=production` like
 *    any real deploy would, so `NODE_ENV` alone can never distinguish the
 *    two; this marker is what a real production deploy has no legitimate
 *    reason to ever set.
 * 2. `DATABASE_URL === TEST_DATABASE_URL` — proof of actual database
 *    routing, not just a configuration marker. `playwright.config.ts`'s own
 *    `requireIsolatedE2eDatabase()` already verifies `TEST_DATABASE_URL` is
 *    a genuinely different database from the app's own `DATABASE_URL`
 *    before assigning it into the spawned server's `DATABASE_URL` — but
 *    that check runs in the Playwright config process, not this one.
 *    Playwright's `webServer.env` inherits (merges with, does not replace)
 *    the launching process's own environment, so `TEST_DATABASE_URL` — set
 *    by the SAME `loadEnvFile(".env")` call that feeds that isolation check
 *    — is independently visible here too, letting this process re-prove
 *    isolation itself rather than trust that the marker above was set
 *    honestly.
 *
 * A partial/inconsistent signal (e.g. `PAYMENT_GATEWAY=e2e-fake` alone,
 * copy-pasted into a real deploy's config, or present without the database
 * actually routed to the isolated test database) is treated as a broken
 * configuration and THROWS rather than logging and quietly falling back to
 * the real Stripe gateway — a silent fallback would mean a broken e2e
 * config could make real Stripe calls in what a developer believes is a
 * fully faked run, which is worse than a loud failure.
 *
 * Residual risk, reported honestly: this proves DATABASE_URL was routed to
 * whatever TEST_DATABASE_URL resolves to in THIS process's environment. It
 * does not re-verify (as `tests/e2e/global-setup.ts`'s live check does) that
 * TEST_DATABASE_URL itself is a genuinely different database from the real
 * DATABASE_URL by connecting and reading Postgres's own `current_database()`
 * — an operator who set `TEST_DATABASE_URL` to the same value as the real
 * `DATABASE_URL` in `.env` would defeat both this check and the harness's
 * own `requireIsolatedE2eDatabase()` guard identically. That failure mode is
 * already the harness's documented responsibility (`playwright.config.ts`
 * throws if the two resolve to the same database name at config-eval time),
 * not something a runtime gateway swap can independently rule out.
 */
export function getPaymentGateway(): PaymentGateway {
  if (!gateway) {
    gateway = resolveGateway();
  }
  return gateway;
}

function resolveGateway(): PaymentGateway {
  const requested = process.env.PAYMENT_GATEWAY;
  if (requested === undefined) return new StripePaymentGateway();
  if (requested !== "e2e-fake") return new StripePaymentGateway();

  const distDir = process.env.E2E_DIST_DIR;
  if (distDir !== E2E_DIST_DIR_MARKER) {
    throw new Error(
      `PAYMENT_GATEWAY=e2e-fake requires E2E_DIST_DIR === ${JSON.stringify(E2E_DIST_DIR_MARKER)} ` +
        `(the dedicated Playwright e2e server's own marker); got ${JSON.stringify(distDir)}. ` +
        "Refusing to start rather than silently falling back to the real Stripe gateway.",
    );
  }

  const databaseUrl = process.env.DATABASE_URL;
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl || !testDatabaseUrl || databaseUrl !== testDatabaseUrl) {
    throw new Error(
      "PAYMENT_GATEWAY=e2e-fake requires DATABASE_URL to be routed to TEST_DATABASE_URL " +
        "(independent proof of database isolation, not just the E2E_DIST_DIR marker). " +
        "Refusing to start the fake gateway against an unverified database.",
    );
  }

  return new E2EFakePaymentGateway();
}

/** Test seam. */
export function __setPaymentGateway(next: PaymentGateway | null): void {
  gateway = next;
}
