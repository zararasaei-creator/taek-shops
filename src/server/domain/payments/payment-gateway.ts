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

/** A provider refund's settlement state — distinct from our local `RefundStatus`. */
export type RefundProviderStatus = "pending" | "succeeded" | "failed" | "canceled";

export interface RefundResult {
  id: string;
  status: RefundProviderStatus;
  amountCents: number;
  paymentIntentId: string;
}

export interface RequestRefundParams {
  paymentIntentId: string;
  /** Omit for a full refund of whatever remains uncaptured-back on the intent. */
  amountCents?: number;
  /**
   * Caller-supplied, stable per refund attempt. Passed through as the
   * provider-level idempotency key too, so retrying with the SAME key (a
   * double click, a network retry) can never create a second refund — the
   * provider returns the original result instead. A legitimate SEPARATE
   * refund attempt must use a different key.
   */
  idempotencyKey: string;
  /**
   * Provider-side metadata to attach to the refund object itself. Carries
   * our local `Refund.id` (`taekShopsRefundId`) so a `refund.updated`
   * webhook that arrives before we've persisted the provider's own refund
   * id — the ambiguous network/timeout case, where `refund()` throws before
   * we ever learn its id — can still be linked back to the right local row.
   * See `reconcileRefundFromEventTx`.
   */
  metadata?: Record<string, string>;
}

export interface PaymentGateway {
  readonly provider: string;

  createPaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntentView>;

  retrievePaymentIntent(id: string): Promise<PaymentIntentView>;

  /**
   * Request cancellation of a still-payable PaymentIntent (abandoned-checkout
   * reservation recovery). The provider is the one source of truth for
   * whether this succeeds: it must REFUSE (a definitive, non-`ambiguous`
   * `PaymentGatewayError`) when the intent has already moved to `succeeded`
   * or `processing` — a caller relies on that refusal as confirmation it
   * raced a real payment, not an invitation to retry. A network/timeout
   * failure (the outcome is genuinely unknown) must be `ambiguous: true`,
   * exactly like `refund()`'s own documented contract, so the caller can
   * tell "definitely still payable" apart from "we don't know." Succeeds
   * only for an intent still in `requires_payment_method`,
   * `requires_confirmation`, or `requires_action`, returning its new
   * `"canceled"` state. Idempotent on `idempotencyKey`, same guarantee as
   * `createPaymentIntent`'s.
   */
  cancelPaymentIntent(id: string, idempotencyKey: string): Promise<PaymentIntentView>;

  /**
   * Find an existing PaymentIntent for this order by provider-side metadata,
   * independent of whether a LOCAL `Payment` row references one. Closes the
   * race where `startPayment`'s own `createPaymentIntent` call already
   * succeeded at the provider but the subsequent local `Payment` row write
   * never landed (a crash or network drop between the two) — the absence of
   * a stored id is not, by itself, proof no provider payment exists. Returns
   * `null` only when the provider genuinely has no PaymentIntent for this
   * order.
   */
  findPaymentIntentForOrder(orderId: string): Promise<PaymentIntentView | null>;

  /**
   * Verify a raw webhook body against the signature header using the webhook
   * signing secret. Throws `WebhookSignatureError` on any failure.
   */
  parseWebhook(rawBody: string, signatureHeader: string | null): WebhookEnvelope;

  /**
   * Request a full or partial refund. May return with `status: "pending"` —
   * the caller must not treat that as settled; reconcile later via
   * `retrieveRefund` or a signature-verified provider event. Throwing means
   * the outcome is unknown (network/timeout) OR the provider definitively
   * declined (e.g. already refunded) — the caller distinguishes those by
   * error type, never by assuming success.
   */
  refund(params: RequestRefundParams): Promise<RefundResult>;

  /** Look up a previously-requested refund's current settlement status. */
  retrieveRefund(id: string): Promise<RefundResult>;
}

export class WebhookSignatureError extends Error {
  readonly code = "invalid_signature";
  constructor(message = "Webhook signature verification failed.") {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

export class PaymentGatewayError extends Error {
  /**
   * True when the provider never gave a definitive answer (network error,
   * timeout, 5xx, or Stripe's `409 idempotency_key_in_use` — another request
   * using the same idempotency key is still in flight, so this request's own
   * outcome is not yet known) — the request may or may not have gone
   * through. False
   * means the provider responded with a definitive decline/error. Callers
   * MUST branch on this rather than assuming either outcome: an ambiguous
   * refund must be left pending for reconciliation, never marked failed
   * (that could invite a second, genuinely duplicate attempt) and never
   * marked succeeded.
   */
  readonly ambiguous: boolean;

  constructor(message: string, options?: { ambiguous?: boolean }) {
    super(message);
    this.name = "PaymentGatewayError";
    this.ambiguous = options?.ambiguous ?? false;
  }
}
