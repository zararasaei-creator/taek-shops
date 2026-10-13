// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `getPaymentGateway()`'s fail-closed swap logic (`src/server/domain/payments/index.ts`).
 * The e2e fake must NEVER activate outside the dedicated Playwright e2e
 * server — that process's `next build && next start` forces
 * `NODE_ENV=production` just like a real deploy would, so this gates on two
 * independent signals instead: `E2E_DIST_DIR` (the harness's own exact
 * marker) AND `DATABASE_URL === TEST_DATABASE_URL` (proof the database was
 * actually routed to the isolated test database, not just a marker being
 * set). Any inconsistency THROWS — before any gateway is constructed —
 * rather than logging and silently falling back to the real gateway.
 */
describe("getPaymentGateway — e2e fake isolation", () => {
  const TEST_DB = "postgresql://taek_test:pw@localhost:5432/taek_shops_test?schema=public";
  const REAL_DB = "postgresql://taek:pw@localhost:5432/taek_shops?schema=public";

  // Every test here does `vi.resetModules()` + a fresh dynamic `import()` of
  // the whole payments module graph (Stripe SDK included). The default 5s
  // timeout is tight enough that, under a full-suite run with many other
  // files cold-importing concurrently, whichever test pays that first-import
  // cost can flake on time alone — reproducible in this file specifically,
  // never in isolation. Not a logic issue with what's being asserted, so
  // every test gets an explicit, longer per-test timeout (`vi.setConfig` in
  // a `beforeAll` does NOT work here — vitest captures each test's timeout
  // at collection time, before any hook runs).
  const TIMEOUT_MS = 15_000;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function load() {
    vi.resetModules();
    return import("@/server/domain/payments");
  }

  it(
    "unset PAYMENT_GATEWAY always uses the real Stripe gateway",
    async () => {
      vi.stubEnv("PAYMENT_GATEWAY", undefined);
      vi.stubEnv("E2E_DIST_DIR", undefined);
      const { getPaymentGateway } = await load();
      expect(getPaymentGateway().constructor.name).toBe("StripePaymentGateway");
    },
    TIMEOUT_MS,
  );

  it(
    "PAYMENT_GATEWAY=e2e-fake without E2E_DIST_DIR throws rather than falling back",
    async () => {
      vi.stubEnv("PAYMENT_GATEWAY", "e2e-fake");
      vi.stubEnv("E2E_DIST_DIR", undefined);
      const { getPaymentGateway } = await load();
      expect(() => getPaymentGateway()).toThrow(/E2E_DIST_DIR/);
    },
    TIMEOUT_MS,
  );

  it(
    "a typo'd E2E_DIST_DIR value throws (exact match required, not merely truthy)",
    async () => {
      vi.stubEnv("PAYMENT_GATEWAY", "e2e-fake");
      vi.stubEnv("E2E_DIST_DIR", ".next-e2e-typo");
      const { getPaymentGateway } = await load();
      expect(() => getPaymentGateway()).toThrow(/E2E_DIST_DIR/);
    },
    TIMEOUT_MS,
  );

  it(
    "a typo'd PAYMENT_GATEWAY value falls back to the real gateway even with E2E_DIST_DIR set",
    async () => {
      vi.stubEnv("PAYMENT_GATEWAY", "e2efake");
      vi.stubEnv("E2E_DIST_DIR", ".next-e2e");
      vi.stubEnv("DATABASE_URL", TEST_DB);
      vi.stubEnv("TEST_DATABASE_URL", TEST_DB);
      const { getPaymentGateway } = await load();
      expect(getPaymentGateway().constructor.name).toBe("StripePaymentGateway");
    },
    TIMEOUT_MS,
  );

  it(
    "production NODE_ENV with e2e-fake but no E2E_DIST_DIR still throws (NODE_ENV is not the gate)",
    async () => {
      // The dedicated e2e harness runs `next start`, which forces
      // NODE_ENV=production too — so NODE_ENV alone must never be the gate.
      // A real production deploy has NODE_ENV=production and no E2E_DIST_DIR.
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("PAYMENT_GATEWAY", "e2e-fake");
      vi.stubEnv("E2E_DIST_DIR", undefined);
      const { getPaymentGateway } = await load();
      expect(() => getPaymentGateway()).toThrow(/E2E_DIST_DIR/);
    },
    TIMEOUT_MS,
  );

  it(
    "E2E_DIST_DIR set correctly but DATABASE_URL not routed to TEST_DATABASE_URL throws",
    async () => {
      vi.stubEnv("PAYMENT_GATEWAY", "e2e-fake");
      vi.stubEnv("E2E_DIST_DIR", ".next-e2e");
      vi.stubEnv("DATABASE_URL", REAL_DB);
      vi.stubEnv("TEST_DATABASE_URL", TEST_DB);
      const { getPaymentGateway } = await load();
      expect(() => getPaymentGateway()).toThrow(/DATABASE_URL/);
    },
    TIMEOUT_MS,
  );

  it(
    "E2E_DIST_DIR set correctly but TEST_DATABASE_URL missing entirely throws",
    async () => {
      vi.stubEnv("PAYMENT_GATEWAY", "e2e-fake");
      vi.stubEnv("E2E_DIST_DIR", ".next-e2e");
      vi.stubEnv("DATABASE_URL", REAL_DB);
      vi.stubEnv("TEST_DATABASE_URL", undefined);
      const { getPaymentGateway } = await load();
      expect(() => getPaymentGateway()).toThrow(/DATABASE_URL/);
    },
    TIMEOUT_MS,
  );

  it(
    "only E2E_DIST_DIR + DATABASE_URL routed to TEST_DATABASE_URL together activate the fake",
    async () => {
      vi.stubEnv("PAYMENT_GATEWAY", "e2e-fake");
      vi.stubEnv("E2E_DIST_DIR", ".next-e2e");
      vi.stubEnv("DATABASE_URL", TEST_DB);
      vi.stubEnv("TEST_DATABASE_URL", TEST_DB);
      const { getPaymentGateway } = await load();
      expect(getPaymentGateway().constructor.name).toBe("E2EFakePaymentGateway");
    },
    TIMEOUT_MS,
  );
});
