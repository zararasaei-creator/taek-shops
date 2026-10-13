// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const piCreate = vi.fn();
const piRetrieve = vi.fn();
const refundCreate = vi.fn();
const refundRetrieve = vi.fn();
const piCancel = vi.fn();
const piSearch = vi.fn();
const constructEvent = vi.fn();

vi.mock("stripe", () => {
  class StripeError extends Error {}
  class StripeConnectionError extends StripeError {}
  class MockStripe {
    paymentIntents = { create: piCreate, retrieve: piRetrieve, cancel: piCancel, search: piSearch };
    refunds = { create: refundCreate, retrieve: refundRetrieve };
    webhooks = { constructEvent };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (MockStripe as any).errors = { StripeError, StripeConnectionError };
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
    piCancel.mockReset();
    piSearch.mockReset();
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

  it("refund passes through the caller's idempotency key", async () => {
    refundCreate.mockResolvedValue({
      id: "re_1",
      status: "succeeded",
      amount: 6850,
      payment_intent: "pi_123",
    });
    const r = await gw.refund({
      paymentIntentId: "pi_123",
      amountCents: 6850,
      idempotencyKey: "refund-abc-123",
    });
    expect(r).toEqual({ id: "re_1", status: "succeeded", amountCents: 6850, paymentIntentId: "pi_123" });
    expect(refundCreate.mock.calls[0]![1]).toEqual({ idempotencyKey: "refund-abc-123" });
  });

  it("retrieveRefund returns the current settlement status", async () => {
    refundRetrieve.mockResolvedValue({
      id: "re_1",
      status: "pending",
      amount: 6850,
      payment_intent: "pi_123",
    });
    const r = await gw.retrieveRefund("re_1");
    expect(r).toEqual({ id: "re_1", status: "pending", amountCents: 6850, paymentIntentId: "pi_123" });
  });

  it("a StripeConnectionError is classified as ambiguous", async () => {
    // Use the mocked SDK's own error class so `instanceof` matches inside stripe.ts.
    const { default: MockedStripe } = await import("stripe");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const StripeConnectionError = (MockedStripe as any).errors.StripeConnectionError;
    refundCreate.mockRejectedValue(new StripeConnectionError("network blip"));
    await expect(
      gw.refund({ paymentIntentId: "pi_123", amountCents: 100, idempotencyKey: "k1" }),
    ).rejects.toMatchObject({ ambiguous: true });
  });

  it("a definitive StripeError is not classified as ambiguous", async () => {
    const { default: MockedStripe } = await import("stripe");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const StripeError = (MockedStripe as any).errors.StripeError;
    refundCreate.mockRejectedValue(new StripeError("already refunded"));
    await expect(
      gw.refund({ paymentIntentId: "pi_123", amountCents: 100, idempotencyKey: "k2" }),
    ).rejects.toMatchObject({ ambiguous: false });
  });

  it("a 409 / idempotency_key_in_use StripeError (concurrent request, same key) is ambiguous — an unknown outcome, never a decline", async () => {
    const { default: MockedStripe } = await import("stripe");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const StripeError = (MockedStripe as any).errors.StripeError;
    const byStatus = Object.assign(new StripeError("conflict"), { statusCode: 409 });
    const byCode = Object.assign(new StripeError("in use"), { code: "idempotency_key_in_use" });
    const params = {
      amountCents: 100,
      currency: "cad",
      metadata: { orderId: "o1" },
      idempotencyKey: "pi-create-o1",
    };
    piCreate.mockRejectedValueOnce(byStatus);
    await expect(gw.createPaymentIntent(params)).rejects.toMatchObject({ ambiguous: true });
    piCreate.mockRejectedValueOnce(byCode);
    await expect(gw.createPaymentIntent(params)).rejects.toMatchObject({ ambiguous: true });
    // A key reused with different parameters is a definitive programming error.
    piCreate.mockRejectedValueOnce(Object.assign(new StripeError("param mismatch"), { statusCode: 400 }));
    await expect(gw.createPaymentIntent(params)).rejects.toMatchObject({ ambiguous: false });
  });

  it("cancelPaymentIntent passes the caller's idempotency key through", async () => {
    piCancel.mockResolvedValue({ ...succeededPi, status: "canceled" });
    const view = await gw.cancelPaymentIntent("pi_123", "pi-expire-o1");
    expect(view.status).toBe("canceled");
    expect(piCancel).toHaveBeenCalledWith("pi_123", undefined, { idempotencyKey: "pi-expire-o1" });
  });

  it("findPaymentIntentForOrder searches by orderId metadata and returns null on a miss", async () => {
    piSearch.mockResolvedValueOnce({ data: [{ ...succeededPi, latest_charge: null }] });
    const hit = await gw.findPaymentIntentForOrder("o1");
    expect(hit?.id).toBe("pi_123");
    expect(piSearch.mock.calls[0]![0]).toMatchObject({ query: "metadata['orderId']:'o1'" });
    piSearch.mockResolvedValueOnce({ data: [] });
    expect(await gw.findPaymentIntentForOrder("o2")).toBeNull();
  });
});
