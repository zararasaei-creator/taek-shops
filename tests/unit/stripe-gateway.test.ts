// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const piCreate = vi.fn();
const piRetrieve = vi.fn();
const refundCreate = vi.fn();
const constructEvent = vi.fn();

vi.mock("stripe", () => {
  class MockStripe {
    paymentIntents = { create: piCreate, retrieve: piRetrieve };
    refunds = { create: refundCreate };
    webhooks = { constructEvent };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (MockStripe as any).errors = { StripeError: class StripeError extends Error {} };
  return { default: MockStripe };
});

import { StripePaymentGateway, __resetStripeClient } from "@/server/domain/payments/stripe";
import { WebhookSignatureError } from "@/server/domain/payments/payment-gateway";

const succeededPi = {
  id: "pi_123",
  status: "succeeded",
  amount: 6850,
  amount_received: 6850,
  currency: "cad",
  client_secret: "pi_123_secret",
  metadata: { orderId: "o1", orderNumber: "TS-1" },
  latest_charge: {
    payment_method_details: { card: { brand: "visa", last4: "4242" } },
  },
  last_payment_error: null,
};

describe("StripePaymentGateway", () => {
  let gw: StripePaymentGateway;
  beforeEach(() => {
    __resetStripeClient();
    piCreate.mockReset();
    piRetrieve.mockReset();
    refundCreate.mockReset();
    constructEvent.mockReset();
    gw = new StripePaymentGateway();
  });

  it("creates a PaymentIntent with a per-request idempotency key and exact amount", async () => {
    piCreate.mockResolvedValue({ ...succeededPi, status: "requires_payment_method" });
    await gw.createPaymentIntent({
      amountCents: 6850,
      currency: "cad",
      metadata: { orderId: "o1", orderNumber: "TS-1" },
      idempotencyKey: "pi-create-o1",
      receiptEmail: "b@example.com",
    });
    expect(piCreate).toHaveBeenCalledTimes(1);
    const [body, opts] = piCreate.mock.calls[0]!;
    expect(body).toMatchObject({
      amount: 6850,
      currency: "cad",
      metadata: { orderId: "o1", orderNumber: "TS-1" },
      automatic_payment_methods: { enabled: true },
    });
    expect(opts).toEqual({ idempotencyKey: "pi-create-o1" });
  });

  it("maps a retrieved intent to a view, including the card brand/last4", async () => {
    piRetrieve.mockResolvedValue(succeededPi);
    const view = await gw.retrievePaymentIntent("pi_123");
    expect(view).toMatchObject({
      id: "pi_123",
      status: "succeeded",
      amount: 6850,
      currency: "cad",
      card: { brand: "visa", last4: "4242" },
    });
  });

  it("parseWebhook rejects a missing signature and delegates otherwise", () => {
    expect(() => gw.parseWebhook("{}", null)).toThrow(WebhookSignatureError);

    constructEvent.mockReturnValue({
      id: "evt_1",
      type: "payment_intent.succeeded",
      data: { object: succeededPi },
    });
    const env = gw.parseWebhook("{raw}", "t=1,v1=abc");
    expect(env).toEqual({ id: "evt_1", type: "payment_intent.succeeded", object: succeededPi });

    constructEvent.mockImplementation(() => {
      throw new Error("No signatures found matching the expected signature for payload");
    });
    expect(() => gw.parseWebhook("{raw}", "bad")).toThrow(WebhookSignatureError);
  });

  it("refund passes an idempotency key", async () => {
    refundCreate.mockResolvedValue({ id: "re_1", status: "succeeded", amount: 6850 });
    const r = await gw.refund("pi_123");
    expect(r).toEqual({ id: "re_1", status: "succeeded", amountCents: 6850 });
    expect(refundCreate.mock.calls[0]![1]).toHaveProperty("idempotencyKey");
  });
});
