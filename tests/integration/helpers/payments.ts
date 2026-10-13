import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import Stripe from "stripe";

import type {
  CreatePaymentIntentParams,
  PaymentGateway,
  PaymentIntentStatus,
  PaymentIntentView,
  RefundProviderStatus,
  RefundResult,
  RequestRefundParams,
  WebhookEnvelope,
} from "@/server/domain/payments";
import { PaymentGatewayError, WebhookSignatureError } from "@/server/domain/payments";

/**
 * Delete exactly the `WebhookEvent` rows a test run owns, by exact id. An
 * empty set is a deliberate no-op — never widen this to a prefix or a
 * blanket `deleteMany`. `WebhookEvent` rows have no relation back to a test
 * fixture (no order id, no namespaced field to filter by), so exact-id
 * tracking is the only safe way to clean up after a run without risking
 * unrelated application webhook history — which an earlier, unscoped
 * `deleteMany({})` in this suite's teardown actually did erase once.
 *
 * Shared by `payments.integration.test.ts`'s teardown and
 * `webhook-cleanup-scope.integration.test.ts`'s regression test, so the
 * regression test exercises this exact function rather than a re-implemented
 * copy of its logic.
 */
export async function cleanupOwnedWebhookEvents(
  db: Pick<PrismaClient, "webhookEvent">,
  ownedEventIds: ReadonlySet<string> | readonly string[],
): Promise<void> {
  const ids = [...ownedEventIds];
  if (ids.length === 0) return;
  await db.webhookEvent.deleteMany({ where: { eventId: { in: ids } } });
}

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
  private readonly refundsByIdempotencyKey = new Map<string, RefundResult>();
  private readonly refundsById = new Map<string, RefundResult>();
  /**
   * Per-idempotency-key scripted outcome for the NEXT `refund()` call using
   * that key. Defaults to an immediate "succeeded" result. Set to a
   * `PaymentGatewayError` to simulate a decline (`ambiguous: false`) or a
   * network/timeout failure (`ambiguous: true`); set to `"pending"` to
   * simulate a refund that settles later, only via `retrieveRefund` or a
   * webhook event.
   */
  private readonly scriptedRefundOutcomes = new Map<
    string,
    RefundProviderStatus | PaymentGatewayError
  >();
  /** Metadata Stripe would echo back on the refund object (set at creation). */
  private readonly metadataById = new Map<string, Record<string, string>>();
  /** Every `refund()` call actually reaching this gateway (not the dedup short-circuit). */
  refundCallCount = 0;
  /**
   * The request "fingerprint" (amount, payment intent, metadata) the FIRST
   * `refund()` call for each idempotency key carried — captured even when
   * that first call ultimately throws (the ambiguous case), so a later
   * retry with the same key is checked against what was ACTUALLY sent
   * originally, exactly like real Stripe: "The idempotency layer compares
   * incoming parameters to those of the original request and errors if
   * they're not the same" (https://docs.stripe.com/api/idempotent_requests).
   */
  private readonly firstAttemptFingerprintByKey = new Map<string, string>();

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

  /** Every `createPaymentIntent()` call actually reaching this gateway. */
  createCallCount = 0;
  /** First-response SNAPSHOT per idempotency key — a replay returns this body (possibly stale), like Stripe. */
  private readonly createResponsesByKey = new Map<string, PaymentIntentView>();
  private scriptedCreate: "lose_response" | PaymentGatewayError | null = null;
  /** When true, `findPaymentIntentForOrder` misses (models Search's indexing lag / outage). */
  searchMisses = false;

  /**
   * Script the NEXT `createPaymentIntent()` call. `"lose_response"`: the
   * provider DOES create the intent (and remembers the key) but the caller
   * gets an ambiguous error — i.e. provider success followed by the caller
   * never learning of it (a crash/timeout before local persistence).
   * A `PaymentGatewayError`: thrown BEFORE anything is created (request
   * never reached the provider).
   */
  scriptCreate(outcome: "lose_response" | PaymentGatewayError): void {
    this.scriptedCreate = outcome;
  }

  /** Models Stripe pruning idempotency keys after their retention: a reused key makes a NEW request. */
  pruneIdempotencyKeys(): void {
    this.createResponsesByKey.clear();
  }

  /** How many distinct intents exist for this order at the provider. */
  intentCountFor(orderId: string): number {
    let n = 0;
    for (const v of this.intents.values()) if (v.metadata.orderId === orderId) n += 1;
    return n;
  }

  async createPaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntentView> {
    this.createCallCount += 1;
    const orderId = params.metadata.orderId ?? "";
    const orderNumber = params.metadata.orderNumber ?? "";

    const scripted = this.scriptedCreate;
    this.scriptedCreate = null;
    if (scripted instanceof PaymentGatewayError) throw scripted;

    // Idempotent on the key, exactly like real Stripe: a replay returns the
    // ORIGINAL response body (whose status may since have gone stale).
    const replay = this.createResponsesByKey.get(params.idempotencyKey);
    if (replay) return { ...replay };

    const view = this.createIntentFor(orderId, orderNumber, params.amountCents);
    this.createResponsesByKey.set(params.idempotencyKey, { ...view });
    if (scripted === "lose_response") {
      throw new PaymentGatewayError("Stripe: connection reset after the request was processed", {
        ambiguous: true,
      });
    }
    return view;
  }

  async retrievePaymentIntent(id: string): Promise<PaymentIntentView> {
    const v = this.intents.get(id);
    if (!v) throw new Error(`no fake intent ${id}`);
    return v;
  }

  private readonly cancelResultsByIdempotencyKey = new Map<string, PaymentIntentView>();
  /**
   * Per-id scripted outcome for the NEXT `cancelPaymentIntent()` call against
   * that intent — set to a `PaymentGatewayError` to simulate an ambiguous
   * network/timeout failure (the abandoned-checkout expiry job must leave
   * local state untouched and retry later for this case specifically).
   * Unset means "behave like real Stripe": succeed for a still-payable
   * status, definitively refuse for `succeeded`/`processing`.
   */
  private readonly scriptedCancelOutcomes = new Map<string, PaymentGatewayError>();

  scriptCancelFailure(id: string, error: PaymentGatewayError): void {
    this.scriptedCancelOutcomes.set(id, error);
  }

  private readonly lostCancelResponses = new Set<string>();
  private beforeCancel: ((id: string) => void) | null = null;
  /** Every `cancelPaymentIntent()` call actually reaching this gateway. */
  cancelCallCount = 0;

  /**
   * The NEXT cancel of this intent is APPLIED at the provider but its response
   * is lost (ambiguous network error) — the worst uncertain case: the caller
   * cannot tell the intent is already canceled.
   */
  scriptCancelLostResponse(id: string): void {
    this.lostCancelResponses.add(id);
  }

  /**
   * One-shot hook run at the very start of the next `cancelPaymentIntent()`,
   * BEFORE the provider evaluates it — lets a test land a customer payment
   * (`patch(id, { status: "succeeded" })`) in the exact window between the
   * caller's last read and the provider seeing the cancel request.
   */
  onNextCancel(hook: (id: string) => void): void {
    this.beforeCancel = hook;
  }

  async cancelPaymentIntent(id: string, idempotencyKey: string): Promise<PaymentIntentView> {
    // Idempotent on the key, exactly like real Stripe — a retry with the
    // SAME key returns the SAME result without re-evaluating anything
    // (including a since-changed status), matching `refund()`'s own
    // idempotency-key handling in this fake.
    this.cancelCallCount += 1;
    const hook = this.beforeCancel;
    this.beforeCancel = null;
    hook?.(id);
    const cached = this.cancelResultsByIdempotencyKey.get(idempotencyKey);
    if (cached) return cached;

    const scripted = this.scriptedCancelOutcomes.get(id);
    if (scripted) {
      this.scriptedCancelOutcomes.delete(id); // one-shot, like scriptRefundOutcome's per-call scripting
      throw scripted;
    }

    const current = this.intents.get(id);
    if (!current) throw new Error(`no fake intent ${id}`);
    // Real Stripe definitively refuses to cancel a PaymentIntent that has
    // already succeeded or is actively processing — never ambiguous, since
    // the provider gave a real, final answer.
    if (current.status === "succeeded" || current.status === "processing") {
      throw new PaymentGatewayError(
        `Stripe: You cannot cancel this PaymentIntent because it has a status of ${current.status}.`,
        { ambiguous: false },
      );
    }
    const next = this.patch(id, { status: "canceled" });
    this.cancelResultsByIdempotencyKey.set(idempotencyKey, next);
    if (this.lostCancelResponses.delete(id)) {
      throw new PaymentGatewayError("Stripe: connection reset after the cancel was processed", {
        ambiguous: true,
      });
    }
    return next;
  }

  async findPaymentIntentForOrder(orderId: string): Promise<PaymentIntentView | null> {
    if (this.searchMisses) return null;
    for (const v of this.intents.values()) {
      if (v.metadata.orderId === orderId) return v;
    }
    return null;
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

  /** Script the outcome of the next `refund()` call carrying this exact idempotency key. */
  scriptRefundOutcome(idempotencyKey: string, outcome: RefundProviderStatus | PaymentGatewayError): void {
    this.scriptedRefundOutcomes.set(idempotencyKey, outcome);
  }

  async refund(params: RequestRefundParams): Promise<RefundResult> {
    this.refundCallCount += 1;

    const fingerprint = JSON.stringify({
      amountCents: params.amountCents ?? null,
      paymentIntentId: params.paymentIntentId,
      metadata: params.metadata ?? null,
    });
    const priorFingerprint = this.firstAttemptFingerprintByKey.get(params.idempotencyKey);
    if (priorFingerprint === undefined) {
      this.firstAttemptFingerprintByKey.set(params.idempotencyKey, fingerprint);
    } else if (priorFingerprint !== fingerprint) {
      // A definitive rejection, exactly like real Stripe would give — never
      // ambiguous, since the provider responded with a real answer.
      throw new PaymentGatewayError(
        "Idempotency key reused with different parameters than the original request.",
        { ambiguous: false },
      );
    }

    // Idempotency, exactly like real Stripe: the SAME key returns the SAME
    // result — no second refund object, whatever the scripted outcome is.
    const existing = this.refundsByIdempotencyKey.get(params.idempotencyKey);
    if (existing) return existing;

    const scripted = this.scriptedRefundOutcomes.get(params.idempotencyKey);
    if (scripted instanceof PaymentGatewayError) {
      // An ambiguous (network/timeout) outcome never produces a refund
      // object at all — the caller genuinely doesn't know what happened.
      throw scripted;
    }

    // A globally-unique id (never per-instance) — this DB-persisted fixture
    // has to stay unique across every test in the file, not just within one
    // gateway instance's own lifetime.
    const result: RefundResult = {
      id: `re_fake_${randomUUID()}`,
      status: scripted ?? "succeeded",
      amountCents: params.amountCents ?? 0,
      paymentIntentId: params.paymentIntentId,
    };
    this.refundsByIdempotencyKey.set(params.idempotencyKey, result);
    this.refundsById.set(result.id, result);
    if (params.metadata) this.metadataById.set(result.id, params.metadata);
    return result;
  }

  /** Metadata that was attached when this refund id was created, if any. */
  metadataFor(id: string): Record<string, string> | undefined {
    return this.metadataById.get(id);
  }

  async retrieveRefund(id: string): Promise<RefundResult> {
    const result = this.refundsById.get(id);
    if (!result) throw new Error(`no fake refund ${id}`);
    return result;
  }

  /** Mutate a stored refund's settlement status (test drives async transitions). */
  patchRefund(id: string, status: RefundProviderStatus): RefundResult {
    const current = this.refundsById.get(id);
    if (!current) throw new Error(`no fake refund ${id}`);
    const next = { ...current, status };
    this.refundsById.set(id, next);
    for (const [key, value] of this.refundsByIdempotencyKey) {
      if (value.id === id) this.refundsByIdempotencyKey.set(key, next);
    }
    return next;
  }
}

/** Build a signed Stripe-style event payload + header. */
export function makeEvent(
  type: string,
  paymentIntent: PaymentIntentView,
  eventId = `evt_test_${randomUUID()}`,
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

/** Build a signed `refund.updated` event payload + header. */
export function makeRefundEvent(
  refund: RefundResult,
  opts: { eventId?: string; currency?: string; metadata?: Record<string, string> | null } = {},
): { body: string; header: string; eventId: string } {
  const eventId = opts.eventId ?? `evt_test_${randomUUID()}`;
  const body = JSON.stringify({
    id: eventId,
    object: "event",
    type: "refund.updated",
    data: {
      object: {
        id: refund.id,
        object: "refund",
        amount: refund.amountCents,
        currency: opts.currency ?? "cad",
        status: refund.status,
        payment_intent: refund.paymentIntentId,
        metadata: opts.metadata ?? null,
      },
    },
  });
  return { body, header: signEvent(body), eventId };
}
