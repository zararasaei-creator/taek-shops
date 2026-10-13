/**
 * Shared email-transport selection for BOTH mailer interfaces — auth
 * (`src/server/auth/mailer.ts`: password reset, email verification) and
 * order emails (`src/server/notifications/order-mailer.ts`: confirmation,
 * shipping notification). One function, one set of fail-closed rules, so
 * the two interfaces can never silently drift apart on when a REAL
 * transport may be selected.
 *
 * Reads `process.env` directly rather than the validated `serverEnv` so
 * this file has zero imports of its own — importable from
 * `src/server/notifications/*` (which must stay resolvable by
 * `scripts/dispatch-emails.ts`, a plain `node` CLI script that cannot
 * resolve the `@/` path alias — see `order-mailer.ts`'s own module
 * comment) via a relative path, and from everywhere else via
 * `@/server/email/transport`.
 */

export type EmailTransportName = "resend" | "local-preview" | "noop";

export interface EmailTransportConfig {
  name: EmailTransportName;
  resend?: { apiKey: string; from: string };
}

/**
 * The exact independent proof that a `NODE_ENV=production` process is the
 * known Playwright e2e harness, not a real live deployment that merely
 * happens to also run a production build. `NODE_ENV` ALONE cannot make this
 * distinction — `playwright.config.ts`'s e2e server runs `npm run build &&
 * npm run start`, which is `NODE_ENV=production` like any real deploy.
 * Mirrors `src/server/domain/payments/index.ts`'s `getPaymentGateway()`
 * exactly, which already needed and solved this identical problem for
 * `PAYMENT_GATEWAY=e2e-fake`: TWO independent conditions, not one —
 * `E2E_DIST_DIR === ".next-e2e"` (a marker with no legitimate reason to be
 * set in a real deploy) AND `DATABASE_URL` actually equal to
 * `TEST_DATABASE_URL` (proof of real database routing, not just a
 * configuration label someone could paste into a real deployment's env by
 * mistake). Both are independently visible here because Playwright's
 * `webServer.env` merges with, rather than replaces, the launching
 * process's own environment — see that file's own comment for the fuller
 * reasoning this borrows.
 *
 * **Residual risk, stated as honestly as `getPaymentGateway()` states its
 * own**: an operator could deliberately set BOTH of these in a real
 * deployment to defeat this check. That is already the accepted, documented
 * residual risk `getPaymentGateway()` carries for the identical pattern —
 * not a new gap introduced here. **This check has not been exercised
 * against an actual live deployment** — no real deployment of this project
 * exists yet. What is verified is that it behaves correctly under every
 * configuration this test suite can construct (see
 * `tests/unit/email-transport.test.ts`); it has not been "activated" in the
 * sense of having stopped a real misconfigured production rollout, because
 * there has been no rollout to stop one on.
 */
function isKnownE2eHarness(): boolean {
  return (
    process.env.E2E_DIST_DIR === ".next-e2e" &&
    Boolean(process.env.DATABASE_URL) &&
    process.env.DATABASE_URL === process.env.TEST_DATABASE_URL
  );
}

/**
 * A real email containing a link back to `localhost`/`127.0.0.1` is a
 * production bug, not merely a cosmetic one — it would make a genuine
 * customer's password-reset or verification link unusable. Checked
 * directly against the raw `NEXT_PUBLIC_APP_URL` (not the Zod-validated
 * `clientEnv`, to keep this file import-free — see module comment) because
 * `clientEnv`'s own schema applies a `http://localhost:3000` DEFAULT when
 * the var is unset, which would make an unset production app URL silently
 * pass a check that only looked at the parsed value.
 */
function pointsAtLocalhost(url: string | undefined): boolean {
  if (!url) return true; // unset -> clientEnv would default to localhost
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);
}

/**
 * Resolve which transport is actually allowed to run. Throws — never
 * silently falls back — when:
 *
 * - A test run requests `"resend"`. `NODE_ENV === "test"` or `VITEST` being
 *   set covers every Vitest run (unit and integration) regardless of what
 *   real credentials a local `.env` happens to contain. This is an
 *   independent layer from the e2e-harness check below, not a substitute
 *   for it — the e2e server runs `NODE_ENV=production`, so this check alone
 *   would not catch it.
 * - Production (`NODE_ENV === "production"`) has NO `EMAIL_TRANSPORT` set
 *   at all — never silently default to a local-preview transport in a real
 *   deployment.
 * - Production requests a non-`"resend"` transport WITHOUT independent
 *   proof this is the known e2e harness (`isKnownE2eHarness()` above) —
 *   NODE_ENV alone cannot tell a real live deployment apart from that
 *   harness, so an explicit `local-preview`/`noop` choice is honoured ONLY
 *   when that independent proof is present; otherwise it is rejected even
 *   though it was explicit, not silent — a real deployment must use
 *   `"resend"`, full stop.
 * - `"resend"` is requested without both `RESEND_API_KEY` and
 *   `EMAIL_FROM_ADDRESS` set, OR without `NEXT_PUBLIC_APP_URL` set to a
 *   real, non-localhost URL — refusing to send a real email whose
 *   password-reset/verification link points at `localhost`.
 */
export function resolveEmailTransport(): EmailTransportConfig {
  // An empty string (an explicitly-set-but-blank env var, e.g. from a
  // deployment tool's template) is treated the same as genuinely unset —
  // matching `optionalOrEmpty()`'s behaviour for every other optional var
  // in `src/server/config/env.ts`'s Zod schema, so the two config paths
  // agree on what "not configured" means.
  const rawRequested = process.env.EMAIL_TRANSPORT;
  const requested = (rawRequested ? rawRequested : undefined) as EmailTransportName | undefined;
  const isProduction = process.env.NODE_ENV === "production";
  const isTestRun = process.env.NODE_ENV === "test" || Boolean(process.env.VITEST);

  if (requested === "resend") {
    if (isTestRun) {
      throw new Error(
        "EMAIL_TRANSPORT=resend must never be selected during a test run (NODE_ENV=test or " +
          "VITEST is set) — refusing to construct a real transport rather than silently using " +
          "it, even if real credentials happen to be present in the environment.",
      );
    }
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM_ADDRESS;
    if (!apiKey || !from) {
      throw new Error(
        "EMAIL_TRANSPORT=resend requires both RESEND_API_KEY and EMAIL_FROM_ADDRESS to be set.",
      );
    }
    if (pointsAtLocalhost(process.env.NEXT_PUBLIC_APP_URL)) {
      throw new Error(
        "EMAIL_TRANSPORT=resend requires NEXT_PUBLIC_APP_URL to be set to a real, non-localhost " +
          "URL — refusing to send a real email whose password-reset/verification link points at " +
          `localhost (got ${JSON.stringify(process.env.NEXT_PUBLIC_APP_URL ?? null)}).`,
      );
    }
    return { name: "resend", resend: { apiKey, from } };
  }

  if (isProduction) {
    if (requested === undefined) {
      throw new Error(
        "EMAIL_TRANSPORT must be explicitly set in production (NODE_ENV=production); got unset. " +
          "Refusing to silently default to a local preview transport in a real deployment.",
      );
    }
    if (!isKnownE2eHarness()) {
      throw new Error(
        `EMAIL_TRANSPORT=${requested} is not allowed in production outside the known e2e ` +
          'harness (requires E2E_DIST_DIR === ".next-e2e" AND DATABASE_URL === TEST_DATABASE_URL ' +
          "— neither alone is sufficient, see isKnownE2eHarness()'s own comment). NODE_ENV=production " +
          "alone cannot distinguish a genuine live deployment from a misconfigured one that merely " +
          'set this explicitly — a real deployment must use "resend".',
      );
    }
  }

  if (requested === "noop") return { name: "noop" };
  if (requested === undefined || requested === "local-preview") return { name: "local-preview" };

  throw new Error(`Unknown EMAIL_TRANSPORT: ${JSON.stringify(requested)}`);
}
