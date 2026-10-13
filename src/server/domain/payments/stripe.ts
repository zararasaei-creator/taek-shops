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
  type RefundProviderStatus,
  type RefundResult,
  type RequestRefundParams,
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

  async cancelPaymentIntent(id: string, idempotencyKey: string): Promise<PaymentIntentView> {
    try {
      const pi = await this.sdk.paymentIntents.cancel(id, undefined, { idempotencyKey });
      return toView(pi);
    } catch (error) {
      throw wrap(error);
    }
  }

  async findPaymentIntentForOrder(orderId: string): Promise<PaymentIntentView | null> {
    try {
      // Stripe's Search API has documented indexing latency (recent writes
      // can lag up to roughly a minute) — acceptable here because this is
      // only ever called for orders already past the expiry policy's
      // minimum age, by which point creation has long since indexed.
      // `orderId` is a `cuid()` (alphanumeric only, no quotes/backslashes),
      // so no escaping is needed for Stripe's search query syntax.
      const result = await this.sdk.paymentIntents.search({
        query: `metadata['orderId']:'${orderId}'`,
        limit: 1,
      });
      const pi = result.data[0];
      return pi ? toView(pi) : null;
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

  async refund(params: RequestRefundParams): Promise<RefundResult> {
    try {
      const refund = await this.sdk.refunds.create(
        {
          payment_intent: params.paymentIntentId,
          amount: params.amountCents,
          metadata: params.metadata,
        },
        { idempotencyKey: params.idempotencyKey },
      );
      return toRefundResult(refund);
    } catch (error) {
      throw wrap(error);
    }
  }

  async retrieveRefund(id: string): Promise<RefundResult> {
    try {
      const refund = await this.sdk.refunds.retrieve(id);
      return toRefundResult(refund);
    } catch (error) {
      throw wrap(error);
    }
  }
}

function toRefundResult(refund: Stripe.Refund): RefundResult {
  const status: RefundProviderStatus =
    refund.status === "succeeded" ||
    refund.status === "pending" ||
    refund.status === "failed" ||
    refund.status === "canceled"
      ? refund.status
      : "pending"; // Stripe's type also allows `null`/`requires_action`; treat as unsettled.
  return {
    id: refund.id,
    status,
    amountCents: refund.amount,
    paymentIntentId:
      typeof refund.payment_intent === "string" ? refund.payment_intent : (refund.payment_intent?.id ?? ""),
  };
}

/**
 * A `StripeConnectionError` (or anything that isn't a definitive API
 * response — timeouts included) means we don't know whether Stripe actually
 * processed the request. Everything else (a card/invalid-request/API error
 * Stripe returned a real response for) is a definitive decline.
 */
function wrap(error: unknown): Error {
  if (error instanceof Stripe.errors.StripeConnectionError) {
    return new PaymentGatewayError(`Stripe: ${error.message}`, { ambiguous: true });
  }
  if (error instanceof Stripe.errors.StripeError) {
    // A concurrent request already using the SAME idempotency key is not a
    // decline: Stripe documents it as `409 Conflict` / code
    // `idempotency_key_in_use` ("making duplicate requests simultaneously" —
    // docs.stripe.com/error-codes; docs.stripe.com/error-low-level
    // #idempotency). The other request's outcome is exactly what this call
    // cannot see yet, so it is an UNKNOWN outcome, not a definitive one —
    // callers (`startPayment`, the abandoned-checkout sweep) must preserve
    // state and retry later, never treat it as "the payment was refused."
    // The SDK itself already retries a 409 automatically
    // (`maxNetworkRetries`); this is what surfaces once those are spent.
    // A key reused with DIFFERENT parameters (`idempotency_error`, 400) is
    // a genuine, definitive programming error and stays non-ambiguous.
    const { statusCode, code } = error as { statusCode?: number; code?: string };
    const concurrentSameKey = statusCode === 409 || code === "idempotency_key_in_use";
    return new PaymentGatewayError(`Stripe: ${error.message}`, { ambiguous: concurrentSameKey });
  }
  // An error the Stripe SDK didn't classify at all (e.g. a raw fetch/abort
  // failure) is exactly the "we don't know what happened" case.
  const message = error instanceof Error ? error.message : String(error);
  return new PaymentGatewayError(message, { ambiguous: true });
}
