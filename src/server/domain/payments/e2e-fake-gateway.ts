import type {
  CreatePaymentIntentParams,
  PaymentGateway,
  PaymentIntentView,
  RefundResult,
  RequestRefundParams,
  WebhookEnvelope,
} from "@/server/domain/payments/payment-gateway";

/**
 * A deterministic, always-succeeds `PaymentGateway` used ONLY by the
 * dedicated e2e server (`playwright.config.ts` sets `PAYMENT_GATEWAY=e2e-fake`
 * for that spawned process only — never for `next dev`/`next start`/CI
 * production). It never calls a real provider. Wired in by
 * `src/server/domain/payments/index.ts`'s `getPaymentGateway()`, gated on
 * that exact env var, so a misconfigured environment fails closed to the
 * real Stripe gateway rather than silently faking payments.
 *
 * This exists so `tests/e2e/admin-refund.spec.ts` can exercise the real
 * admin UI -> server action -> `refund-service.ts` -> `PaymentGateway`
 * path end-to-end through a real browser, without ever reaching Stripe.
 * It does not prove real Stripe refund behaviour — see
 * `tests/integration/refund.integration.test.ts` (a controlled double, same
 * caveat) and `docs/implementation-roadmap.md` for what remains
 * provider-unverified.
 */
export class E2EFakePaymentGateway implements PaymentGateway {
  readonly provider = "stripe";
  private counter = 0;

  async createPaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntentView> {
    this.counter += 1;
    return {
      id: `pi_e2efake_${this.counter}`,
      status: "succeeded",
      amount: params.amountCents,
      amountReceived: params.amountCents,
      currency: params.currency,
      clientSecret: `pi_e2efake_${this.counter}_secret`,
      metadata: params.metadata,
      card: { brand: "visa", last4: "4242" },
      lastError: null,
    };
  }

  async retrievePaymentIntent(id: string): Promise<PaymentIntentView> {
    return {
      id,
      status: "succeeded",
      amount: 0,
      amountReceived: 0,
      currency: "cad",
      clientSecret: null,
      metadata: {},
      card: { brand: "visa", last4: "4242" },
      lastError: null,
    };
  }

  /**
   * Not exercised by any existing e2e spec (only the refund flow uses this
   * gateway) — a harmless, deterministic stub, not a tested behaviour.
   */
  async cancelPaymentIntent(id: string): Promise<PaymentIntentView> {
    return {
      id,
      status: "canceled",
      amount: 0,
      amountReceived: 0,
      currency: "cad",
      clientSecret: null,
      metadata: {},
      card: null,
      lastError: null,
    };
  }

  /** This fake never persists created intents in a lookup-friendly way — nothing to find. */
  async findPaymentIntentForOrder(): Promise<PaymentIntentView | null> {
    return null;
  }

  parseWebhook(): WebhookEnvelope {
    throw new Error("E2EFakePaymentGateway does not support webhooks.");
  }

  async refund(params: RequestRefundParams): Promise<RefundResult> {
    this.counter += 1;
    return {
      id: `re_e2efake_${this.counter}`,
      status: "succeeded",
      amountCents: params.amountCents ?? 0,
      paymentIntentId: params.paymentIntentId,
    };
  }

  async retrieveRefund(id: string): Promise<RefundResult> {
    return { id, status: "succeeded", amountCents: 0, paymentIntentId: "" };
  }
}
