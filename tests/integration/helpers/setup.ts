import { loadEnvFile } from "node:process";

import { PrismaClient } from "@prisma/client";

import { __setOrderMailer } from "@/server/notifications";
import { FakeOrderMailer } from "./order-mailer";
import { __setMailer } from "@/server/auth/mailer";
import { FakeMailer } from "./auth-mailer";
import { __setPaymentGateway } from "@/server/domain/payments";
import { FakeStripeGateway } from "./payments";

/**
 * Integration tests talk to a real database. Load the project `.env` (the Prisma
 * CLI does the same via `prisma.config.ts`) so `DATABASE_URL` is the local
 * docker-compose Postgres, not the unit-test placeholder.
 *
 * This runs before any test module — and therefore before `@/server/db/client`
 * constructs the shared PrismaClient — so widening the connection pool here means
 * every service call in the suite (which uses that shared client) gets the
 * headroom the concurrency tests need: dozens of simultaneous interactive
 * transactions, each holding a connection while it waits on a `FOR UPDATE` lock.
 */
try {
  loadEnvFile(".env");
} catch {
  // No .env — rely on the ambient environment (CI).
}

const appDatabaseUrl = process.env.DATABASE_URL;
if (!appDatabaseUrl) {
  throw new Error(
    "Integration tests need DATABASE_URL. Start Postgres (`docker compose up -d`), " +
      "apply migrations (`npm run db:deploy`), then re-run `npm run test:integration`.",
  );
}

/**
 * Fail-closed test-database isolation.
 *
 * Integration tests run real deletes (order/product/webhook cleanup). Running
 * them against the same database the application uses is unsafe — it has
 * already collaterally erased unrelated webhook history once.
 *
 * A matching hostname/IP is NOT proof of isolation: `localhost`, `127.0.0.1`,
 * and a container's own name can all reach the identical server and database.
 * So the database NAME must differ — checked as its own, independent,
 * mandatory condition, never folded into an "and everything else also
 * matches" comparison. On top of that static check, this actually connects
 * to `TEST_DATABASE_URL` and confirms Postgres itself reports the expected,
 * distinct database — proof the URL isn't merely well-formed but genuinely
 * reaches a different, live database. Neither URL is ever logged.
 */
function targetIdentity(url: string): { host: string; port: string; database: string } {
  const parsed = new URL(url);
  return {
    host: parsed.hostname.toLowerCase(),
    port: parsed.port || "5432",
    database: parsed.pathname.replace(/^\//, "").toLowerCase(),
  };
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error(
    "Integration tests require TEST_DATABASE_URL — a database distinct from the application's " +
      "DATABASE_URL. Refusing to run against the application database (this has previously " +
      "erased unrelated webhook history). See tests/integration/README.md to create one, then " +
      "set TEST_DATABASE_URL in your local .env and re-run. Do not point it at the " +
      "application's own database.",
  );
}

if (testDatabaseUrl === appDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is byte-identical to DATABASE_URL. Refusing to run integration tests " +
      "against the application database.",
  );
}

let appTarget: ReturnType<typeof targetIdentity>;
let testTarget: ReturnType<typeof targetIdentity>;
try {
  appTarget = targetIdentity(appDatabaseUrl);
  testTarget = targetIdentity(testDatabaseUrl);
} catch {
  throw new Error(
    "Could not parse DATABASE_URL / TEST_DATABASE_URL to verify test-database isolation. " +
      "Refusing to run integration tests until this can be confirmed safe.",
  );
}

// Mandatory on its own: same database NAME means the same actual database,
// regardless of whether the host string also happens to differ.
if (appTarget.database === testTarget.database) {
  throw new Error(
    "TEST_DATABASE_URL resolves to the SAME database name as the application's DATABASE_URL " +
      `("${testTarget.database}"). A different host or hostname spelling is not proof of ` +
      "isolation — localhost/127.0.0.1/container aliases can reach the same database. " +
      "Refusing to run integration tests. Point TEST_DATABASE_URL at a genuinely separate " +
      "database name (e.g. taek_shops_test).",
  );
}

// Redundant with the check above when the database name already differs, but
// still the correct hard stop if host/port/database ever end up all equal.
if (
  appTarget.host === testTarget.host &&
  appTarget.port === testTarget.port &&
  appTarget.database === testTarget.database
) {
  throw new Error(
    "TEST_DATABASE_URL resolves to the SAME host/port/database as the application's " +
      "DATABASE_URL. Refusing to run integration tests against the application database.",
  );
}

// Live proof, not just string parsing: connect to TEST_DATABASE_URL and have
// Postgres itself report the database it resolved to. This catches a
// TEST_DATABASE_URL that is unreachable, misconfigured, or — via some alias
// this parser didn't anticipate — actually the same physical database despite
// a different-looking name.
const probe = new PrismaClient({ datasourceUrl: testDatabaseUrl });
try {
  const rows = await probe.$queryRawUnsafe<{ current_database: string }[]>(
    "SELECT current_database()",
  );
  const liveDatabaseName = rows[0]?.current_database?.toLowerCase();
  if (!liveDatabaseName) {
    throw new Error("empty response");
  }
  if (liveDatabaseName !== testTarget.database) {
    throw new Error(
      `TEST_DATABASE_URL's own resolved database name ("${testTarget.database}") does not ` +
        "match what Postgres reports it actually connected to. Refusing to run integration " +
        "tests until TEST_DATABASE_URL's target can be confirmed.",
    );
  }
  if (liveDatabaseName === appTarget.database) {
    throw new Error(
      "TEST_DATABASE_URL connected to a live database whose name matches the application's " +
        "DATABASE_URL. Refusing to run integration tests against the application database.",
    );
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`Could not verify TEST_DATABASE_URL isolation by connecting to it: ${message}`);
} finally {
  await probe.$disconnect();
}

// Verified distinct from the application's database, by both static parsing
// and a live connection — integration tests use this target for the rest of
// the run.
process.env.DATABASE_URL = testDatabaseUrl;
console.info(
  "[integration-setup] Test-database isolation verified (distinct database name, confirmed live).",
);

if (!/[?&]connection_limit=/.test(process.env.DATABASE_URL)) {
  const sep = process.env.DATABASE_URL.includes("?") ? "&" : "?";
  process.env.DATABASE_URL = `${process.env.DATABASE_URL}${sep}connection_limit=60&pool_timeout=30`;
}

/**
 * Safe global default (Phase 8) for the whole integration run: a
 * `FakeOrderMailer`, never the real `LocalPreviewOrderMailer`. Any test that
 * exercises a payment success or a fulfilment change reaching FULFILLED —
 * even ones with nothing to do with email, like the Phase 7 payment suite —
 * fires `kickEmailDispatch`'s best-effort send afterward. Without this, every
 * such test would silently write a local preview file as an unrelated side
 * effect. A test file that specifically wants to assert on mailer behaviour
 * overrides this with its own `FakeOrderMailer` instance in its own
 * `beforeEach`/test body, same as any other test seam.
 */
__setOrderMailer(new FakeOrderMailer());

/**
 * Same safe global default for the auth `Mailer` (password reset, email
 * verification) — never the real `ResendMailer`, never even the harmless
 * `LocalPreviewMailer` (which would otherwise write a stray local preview
 * file for any test that exercises `requestPasswordReset`/
 * `requestEmailVerification` without injecting its own mailer). A test
 * that wants to assert on auth-mailer behaviour overrides this with its own
 * `FakeMailer` instance, same as the order-mailer seam above. Note:
 * `resolveEmailTransport()` (`src/server/email/transport.ts`) already
 * refuses to select the real Resend transport during any Vitest run
 * (`NODE_ENV=test`/`VITEST` is always set here) even without this override
 * — this is defense in depth plus test hygiene, not the only thing
 * standing between this suite and a real send.
 */
__setMailer(new FakeMailer());

/**
 * Safe global default for the PAYMENT gateway — never the real `StripePaymentGateway`.
 * Any service that resolves `getPaymentGateway()` without a test-injected gateway
 * (e.g. an admin cancel of a payment-less order searching the provider for a stray
 * PaymentIntent) would otherwise reach real Stripe whenever the environment holds a
 * Stripe key — found when a clean CI run, with only a synthetic key, failed those
 * tests with "Invalid API key" and showed they had been calling Stripe's TEST-mode
 * API from developer machines. Suites that need their own gateway still call
 * `__setPaymentGateway(...)` themselves, exactly as before.
 */
__setPaymentGateway(new FakeStripeGateway());
