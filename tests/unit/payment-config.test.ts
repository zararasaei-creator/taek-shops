// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

describe("stripe config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function load() {
    vi.resetModules();
    return import("@/server/payments/config");
  }

  it("isStripeConfigured requires both the secret key and the webhook secret", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", undefined);
    let cfg = await load();
    expect(cfg.isStripeConfigured()).toBe(false);
    expect(() => cfg.requireStripeWebhookSecret()).toThrow();

    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_x");
    cfg = await load();
    expect(cfg.isStripeConfigured()).toBe(true);
    expect(cfg.requireStripeSecretKey()).toBe("sk_test_x");
  });
});
