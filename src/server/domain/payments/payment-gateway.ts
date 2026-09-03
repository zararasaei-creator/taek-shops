/**
 * Payment boundary (architecture §10).
 *
 * `PaymentGateway` is the provider-agnostic contract the order/payment services
 * depend on. Stripe is the first implementation (`./stripe.ts`). **No card data
 * ever crosses this boundary** — the browser talks to the provider directly; we
 * exchange only a PaymentIntent id, its status, the amount, and the
 * non-sensitive card brand / last4 the provider returns.
 */

export type PaymentIntentStatus =
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_action"
  | "processing"
  | "requires_capture"
  | "succeeded"
  | "canceled";

export interface PaymentIntentView {
  id: string;
  status: PaymentIntentStatus;
  /** Integer minor units (cents). */
  amount: number;
  amountReceived: number;
  /** Lower-case ISO 4217, e.g. "cad". */
  currency: string;
  clientSecret: string | null;
  /** Free-form metadata we set at creation (e.g. orderId, orderNumber). */
  metadata: Record<string, string>;
  /** Non-sensitive display info from the settled charge, when available. */
  card: { brand: string | null; last4: string | null } | null;
  /** Provider failure message, when the last attempt failed. */
  lastError: string | null;
}

export interface CreatePaymentIntentParams {
  amountCents: number;
  /** Lower-case ISO 4217. */
  currency: string;
  metadata: Record<string, string>;
  /**
   * Provider-level idempotency key — a retry with the same key returns the
   * original PaymentIntent instead of creating (and charging) a second one.
   */
  idempotencyKey: string;
  description?: string;
  receiptEmail?: string;
}

export interface WebhookEnvelope {
  id: string;
  type: string;
  /** The event's primary object (already provider-verified via the signature). */
  object: unknown;
}

export interface RefundResult {
  id: string;
  status: string;
  amountCents: number;
}

export interface PaymentGateway {
  readonly provider: string;

  createPaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntentView>;

  retrievePaymentIntent(id: string): Promise<PaymentIntentView>;

  /**
   * Verify a raw webhook body against the signature header using the webhook
   * signing secret. Throws `WebhookSignatureError` on any failure.
   */
  parseWebhook(rawBody: string, signatureHeader: string | null): WebhookEnvelope;

  /** Provider passthrough. The order/inventory side effects of a refund are Phase 8. */
  refund(paymentIntentId: string, amountCents?: number): Promise<RefundResult>;
}

export class WebhookSignatureError extends Error {
  readonly code = "invalid_signature";
  constructor(message = "Webhook signature verification failed.") {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

export class PaymentGatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentGatewayError";
  }
}
