// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveEmailTransport } from "@/server/email/transport";

/**
 * `resolveEmailTransport()` is the one fail-closed gate both
 * `src/server/auth/mailer.ts` and `src/server/notifications/order-mailer.ts`
 * share — covered directly, independent of either mailer, so a mistake here
 * can't hide behind either one's own happy-path tests.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveEmailTransport — test-run safety", () => {
  it("refuses EMAIL_TRANSPORT=resend during a test run (NODE_ENV=test), even with real-looking credentials present", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("EMAIL_TRANSPORT", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_looks_real");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "noreply@example.test");
    expect(() => resolveEmailTransport()).toThrow(/must never be selected during a test run/i);
  });

  it("refuses EMAIL_TRANSPORT=resend when VITEST is set, regardless of NODE_ENV", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", "true");
    vi.stubEnv("EMAIL_TRANSPORT", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_looks_real");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "noreply@example.test");
    expect(() => resolveEmailTransport()).toThrow(/must never be selected during a test run/i);
  });
});

describe("resolveEmailTransport — production never silently defaults", () => {
  it("throws when production has no EMAIL_TRANSPORT set at all", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("EMAIL_TRANSPORT", "");
    expect(() => resolveEmailTransport()).toThrow(/must be explicitly set in production/i);
  });

  it("succeeds in production with resend configured correctly (and a real app URL)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("EMAIL_TRANSPORT", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_real_key");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "noreply@example.test");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://www.taekshops.ca");
    expect(resolveEmailTransport()).toEqual({
      name: "resend",
      resend: { apiKey: "re_real_key", from: "noreply@example.test" },
    });
  });
});

describe("resolveEmailTransport — an explicit non-resend choice in production is only honoured for the known e2e harness", () => {
  it("REJECTS an explicit local-preview in production without the e2e harness markers — NODE_ENV alone proves nothing", () => {
    // This is the exact scenario a misconfigured real deployment would hit:
    // NODE_ENV=production (like any real deploy) with EMAIL_TRANSPORT
    // explicitly, but mistakenly, set to something other than "resend" and
    // none of the e2e-only markers present.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("EMAIL_TRANSPORT", "local-preview");
    vi.stubEnv("E2E_DIST_DIR", "");
    vi.stubEnv("DATABASE_URL", "postgres://real-prod-host/real_db");
    vi.stubEnv("TEST_DATABASE_URL", "");
    expect(() => resolveEmailTransport()).toThrow(/not allowed in production outside the known e2e harness/i);
  });

  it("REJECTS even with E2E_DIST_DIR set alone, without DATABASE_URL also matching TEST_DATABASE_URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("EMAIL_TRANSPORT", "local-preview");
    vi.stubEnv("E2E_DIST_DIR", ".next-e2e");
    vi.stubEnv("DATABASE_URL", "postgres://real-prod-host/real_db");
    vi.stubEnv("TEST_DATABASE_URL", "postgres://localhost/taek_shops_test");
    expect(() => resolveEmailTransport()).toThrow(/not allowed in production outside the known e2e harness/i);
  });

  it("HONOURS an explicit local-preview in production when BOTH e2e-harness markers independently agree — exactly playwright.config.ts's own setup", () => {
    const testDbUrl = "postgres://localhost/taek_shops_test";
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("EMAIL_TRANSPORT", "local-preview");
    vi.stubEnv("E2E_DIST_DIR", ".next-e2e");
    vi.stubEnv("DATABASE_URL", testDbUrl);
    vi.stubEnv("TEST_DATABASE_URL", testDbUrl);
    expect(resolveEmailTransport()).toEqual({ name: "local-preview" });
  });

  it("HONOURS an explicit noop in production under the same two-factor e2e proof", () => {
    const testDbUrl = "postgres://localhost/taek_shops_test";
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("EMAIL_TRANSPORT", "noop");
    vi.stubEnv("E2E_DIST_DIR", ".next-e2e");
    vi.stubEnv("DATABASE_URL", testDbUrl);
    vi.stubEnv("TEST_DATABASE_URL", testDbUrl);
    expect(resolveEmailTransport()).toEqual({ name: "noop" });
  });
});

describe("resolveEmailTransport — resend requires a real, non-localhost app URL", () => {
  it("throws when NEXT_PUBLIC_APP_URL is unset", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("EMAIL_TRANSPORT", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_real_key");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "noreply@example.test");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(() => resolveEmailTransport()).toThrow(/NEXT_PUBLIC_APP_URL to be set to a real, non-localhost URL/i);
  });

  it("throws when NEXT_PUBLIC_APP_URL explicitly points at localhost", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("EMAIL_TRANSPORT", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_real_key");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "noreply@example.test");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
    expect(() => resolveEmailTransport()).toThrow(/NEXT_PUBLIC_APP_URL to be set to a real, non-localhost URL/i);
  });

  it("throws when NEXT_PUBLIC_APP_URL explicitly points at 127.0.0.1", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("EMAIL_TRANSPORT", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_real_key");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "noreply@example.test");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://127.0.0.1:3000");
    expect(() => resolveEmailTransport()).toThrow(/NEXT_PUBLIC_APP_URL to be set to a real, non-localhost URL/i);
  });

  it("succeeds with a real public URL", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("EMAIL_TRANSPORT", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_real_key");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "noreply@example.test");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://www.taekshops.ca");
    expect(resolveEmailTransport()).toEqual({
      name: "resend",
      resend: { apiKey: "re_real_key", from: "noreply@example.test" },
    });
  });
});

describe("resolveEmailTransport — resend requires both credentials", () => {
  it("throws when RESEND_API_KEY is missing", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("EMAIL_TRANSPORT", "resend");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "noreply@example.test");
    expect(() => resolveEmailTransport()).toThrow(/requires both RESEND_API_KEY and EMAIL_FROM_ADDRESS/i);
  });

  it("throws when EMAIL_FROM_ADDRESS is missing", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("EMAIL_TRANSPORT", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_real_key");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "");
    expect(() => resolveEmailTransport()).toThrow(/requires both RESEND_API_KEY and EMAIL_FROM_ADDRESS/i);
  });
});

describe("resolveEmailTransport — outside production, local transports work without any resend config", () => {
  it("defaults to local-preview when EMAIL_TRANSPORT is unset", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("EMAIL_TRANSPORT", "");
    expect(resolveEmailTransport()).toEqual({ name: "local-preview" });
  });

  it("honours an explicit local-preview", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("EMAIL_TRANSPORT", "local-preview");
    expect(resolveEmailTransport()).toEqual({ name: "local-preview" });
  });

  it("honours an explicit noop", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("EMAIL_TRANSPORT", "noop");
    expect(resolveEmailTransport()).toEqual({ name: "noop" });
  });

  it("rejects an unknown transport name", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("EMAIL_TRANSPORT", "sendgrid");
    expect(() => resolveEmailTransport()).toThrow(/unknown email_transport/i);
  });
});
