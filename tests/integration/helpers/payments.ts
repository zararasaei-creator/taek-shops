import Stripe from "stripe";

import type {
  CreatePaymentIntentParams,
  PaymentGateway,
  PaymentIntentStatus,
  PaymentIntentView,
  RefundResult,
  WebhookEnvelope,
} from "@/server/domain/payments";
import { WebhookSignatureError } from "@/server/domain/payments";

/**
 * A `PaymentGateway` for the Phase 7 integration tests. It does NOT talk to
 * Stripe — `createPaymentIntent` / `retrievePaymentIntent` return
 * test-controlled intents — but `parseWebhook` runs the REAL Stripe signature
 * verification against `WEBHOOK_SECRET`, so the "invalid signature" and
 * "tampered body" paths are genuinely exercised.
 */
export const WEBHOOK_SECRET = "whsec_integration_test_secret";

const realStripe = new Stripe("sk_test_x", {
  apiVersion: "2026-08-26.dahlia" as Stripe.LatestApiVersion,
});

export function signEvent(payload: string, secret = WEBHOOK_SECRET): string {
  return realStripe.webhooks.generateTestHeaderString({ payload, secret });
}

let counter = 0;

export class FakeStripeGateway implements PaymentGateway {
  readonly provider = "stripe";
  private readonly intents = new Map<string, PaymentIntentView>();

  createIntentFor(
    orderId: string,
    orderNumber: string,
    amountCents: number,
    status: PaymentIntentStatus = "requires_payment_method",
  ): PaymentIntentView {
    counter += 1;
    const view: PaymentIntentView = {
      id: `pi_fake_${counter}`,
      status,
      amount: amountCents,
      amountReceived: status === "succeeded" ? amountCents : 0,
      currency: "cad",
      clientSecret: `pi_fake_${counter}_secret`,
      metadata: { orderId, orderNumber },
      card: status === "succeeded" ? { brand: "visa", last4: "4242" } : null,
      lastError: null,
    };
    this.intents.set(view.id, view);
    return view;
  }

  /** Mutate a stored intent (test drives status/amount transitions). */
  patch(id: string, changes: Partial<PaymentIntentView>): PaymentIntentView {
    const current = this.intents.get(id);
    if (!current) throw new Error(`no fake intent ${id}`);
    const next = { ...current, ...changes };
    this.intents.set(id, next);
    return next;
  }

  async createPaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntentView> {
    const orderId = params.metadata.orderId ?? "";
    const orderNumber = params.metadata.orderNumber ?? "";
    // Honour the per-order idempotency key like Stripe does.
    for (const v of this.intents.values()) {
      if (v.metadata.orderId === orderId) return v;
    }
    return this.createIntentFor(orderId, orderNumber, params.amountCents);
  }

  async retrievePaymentIntent(id: string): Promise<PaymentIntentView> {
    const v = this.intents.get(id);
    if (!v) throw new Error(`no fake intent ${id}`);
    return v;
  }

  parseWebhook(rawBody: string, signatureHeader: string | null): WebhookEnvelope {
    if (!signatureHeader) throw new WebhookSignatureError("missing signature");
    try {
      const event = realStripe.webhooks.constructEvent(rawBody, signatureHeader, WEBHOOK_SECRET);
      return { id: event.id, type: event.type, object: event.data.object };
    } catch (error) {
      throw new WebhookSignatureError(error instanceof Error ? error.message : "bad signature");
    }
  }

  async refund(paymentIntentId: string, amountCents?: number): Promise<RefundResult> {
    return { id: `re_${paymentIntentId}`, status: "succeeded", amountCents: amountCents ?? 0 };
  }
}

/** Build a signed Stripe-style event payload + header. */
export function makeEvent(
  type: string,
  paymentIntent: PaymentIntentView,
  eventId = `evt_${type}_${Math.random().toString(36).slice(2)}`,
): { body: string; header: string; eventId: string } {
  const body = JSON.stringify({
    id: eventId,
    object: "event",
    type,
    data: {
      object: {
        id: paymentIntent.id,
        object: "payment_intent",
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
        status: paymentIntent.status,
        metadata: paymentIntent.metadata,
      },
    },
  });
  return { body, header: signEvent(body), eventId };
}
