// @vitest-environment node
import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StripePaymentGateway, __resetStripeClient } from "@/server/domain/payments/stripe";
import { WebhookSignatureError } from "@/server/domain/payments/payment-gateway";

/**
 * Real (offline) Stripe signature verification — no SDK mock. Uses the Stripe
 * library's own `generateTestHeaderString` to sign a payload, then checks that
 * `parseWebhook` accepts a good signature and rejects every tampered variant.
 */
const SECRET = "whsec_unit_placeholder"; // matches tests/unit/setup.ts
const stripe = new Stripe("sk_test_x", {
  apiVersion: "2026-08-26.dahlia" as Stripe.LatestApiVersion,
});

function sign(payload: string, secret = SECRET): string {
  return stripe.webhooks.generateTestHeaderString({ payload, secret });
}

describe("webhook signature verification (real crypto)", () => {
  let gw: StripePaymentGateway;
  beforeEach(() => {
    vi.unstubAllEnvs();
    __resetStripeClient();
    gw = new StripePaymentGateway();
  });

  const body = JSON.stringify({
    id: "evt_test_1",
    type: "payment_intent.succeeded",
    data: { object: { id: "pi_test_1", amount: 1000 } },
  });

  it("accepts a correctly signed payload", () => {
    const env = gw.parseWebhook(body, sign(body));
    expect(env).toMatchObject({ id: "evt_test_1", type: "payment_intent.succeeded" });
    expect((env.object as { id: string }).id).toBe("pi_test_1");
  });

  it("rejects a tampered body", () => {
    const header = sign(body);
    const tampered = body.replace('"amount":1000', '"amount":1');
    expect(() => gw.parseWebhook(tampered, header)).toThrow(WebhookSignatureError);
  });

  it("rejects a signature made with a different secret", () => {
    expect(() => gw.parseWebhook(body, sign(body, "whsec_wrong_secret"))).toThrow(
      WebhookSignatureError,
    );
  });

  it("rejects a missing or malformed signature header", () => {
    expect(() => gw.parseWebhook(body, null)).toThrow(WebhookSignatureError);
    expect(() => gw.parseWebhook(body, "not-a-real-header")).toThrow(WebhookSignatureError);
  });
});
