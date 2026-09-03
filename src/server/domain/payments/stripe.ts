import Stripe from "stripe";

import {
  STRIPE_API_VERSION,
  requireStripeSecretKey,
  requireStripeWebhookSecret,
} from "@/server/payments/config";
import {
  PaymentGatewayError,
  WebhookSignatureError,
  type CreatePaymentIntentParams,
  type PaymentGateway,
  type PaymentIntentStatus,
  type PaymentIntentView,
  type RefundResult,
  type WebhookEnvelope,
} from "@/server/domain/payments/payment-gateway";

/**
 * Stripe implementation of `PaymentGateway` (architecture §10). Card data never
 * reaches this code — the browser confirms the PaymentIntent directly with
 * Stripe via the Payment Element; here we only create/read PaymentIntents and
 * verify webhook signatures.
 */

let client: Stripe | null = null;

/** Lazily-constructed, so the app boots without Stripe configured. */
export function stripeClient(): Stripe {
  if (!client) {
    client = new Stripe(requireStripeSecretKey(), {
      apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion,
      typescript: true,
      // Small, bounded retry budget for transient network errors. Combined with
      // the per-request idempotency keys this never double-charges.
      maxNetworkRetries: 2,
      timeout: 20_000,
    });
  }
  return client;
}

/** Test seam — reset the memoised client (used by unit tests). */
export function __resetStripeClient(): void {
  client = null;
}

function toView(pi: Stripe.PaymentIntent): PaymentIntentView {
  const charge = pi.latest_charge && typeof pi.latest_charge !== "string" ? pi.latest_charge : null;
  const card = charge?.payment_method_details?.card ?? null;
  return {
    id: pi.id,
    status: pi.status as PaymentIntentStatus,
    amount: pi.amount,
    amountReceived: pi.amount_received,
    currency: pi.currency,
    clientSecret: pi.client_secret,
    metadata: (pi.metadata as Record<string, string>) ?? {},
    card: card ? { brand: card.brand ?? null, last4: card.last4 ?? null } : null,
    lastError: pi.last_payment_error?.message ?? null,
  };
}

export class StripePaymentGateway implements PaymentGateway {
  readonly provider = "stripe";

  private get sdk(): Stripe {
    return stripeClient();
  }

  async createPaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntentView> {
    try {
      const pi = await this.sdk.paymentIntents.create(
        {
          amount: params.amountCents,
          currency: params.currency,
          metadata: params.metadata,
          description: params.description,
          receipt_email: params.receiptEmail,
          automatic_payment_methods: { enabled: true },
        },
        { idempotencyKey: params.idempotencyKey },
      );
      return toView(pi);
    } catch (error) {
      throw wrap(error);
    }
  }

  async retrievePaymentIntent(id: string): Promise<PaymentIntentView> {
    try {
      const pi = await this.sdk.paymentIntents.retrieve(id, { expand: ["latest_charge"] });
      return toView(pi);
    } catch (error) {
      throw wrap(error);
    }
  }

  parseWebhook(rawBody: string, signatureHeader: string | null): WebhookEnvelope {
    if (!signatureHeader) throw new WebhookSignatureError("Missing Stripe-Signature header.");
    try {
      const event = this.sdk.webhooks.constructEvent(
        rawBody,
        signatureHeader,
        requireStripeWebhookSecret(),
      );
      return { id: event.id, type: event.type, object: event.data.object };
    } catch (error) {
      throw new WebhookSignatureError(
        error instanceof Error ? error.message : "Webhook signature verification failed.",
      );
    }
  }

  async refund(paymentIntentId: string, amountCents?: number): Promise<RefundResult> {
    try {
      const refund = await this.sdk.refunds.create(
        { payment_intent: paymentIntentId, amount: amountCents },
        { idempotencyKey: `refund-${paymentIntentId}-${amountCents ?? "full"}` },
      );
      return {
        id: refund.id,
        status: refund.status ?? "unknown",
        amountCents: refund.amount,
      };
    } catch (error) {
      throw wrap(error);
    }
  }
}

function wrap(error: unknown): Error {
  if (error instanceof Stripe.errors.StripeError) {
    return new PaymentGatewayError(`Stripe: ${error.message}`);
  }
  return error instanceof Error ? error : new PaymentGatewayError(String(error));
}
