import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { recordAudit } from "@/server/audit/audit-service";
import { AUDIT_ACTIONS } from "@/server/audit/actions";
import { isStripeConfigured } from "@/server/payments/config";
import { getPaymentGateway, WebhookSignatureError } from "@/server/domain/payments";
import type { RefundProviderStatus } from "@/server/domain/payments";
import { finalizeFailureTx, finalizeFromPaymentIntentTx } from "@/server/orders/payment-service";
import { reconcileRefundFromEventTx } from "@/server/orders/refund-service";
import { kickEmailDispatch } from "@/server/notifications";
import { errorFields, logError, logWarn } from "@/server/observability/logger";

/**
 * Stripe webhook (Phase 7). Authoritative payment completion happens here —
 * never on a browser redirect.
 *
 * - Signature is verified with `STRIPE_WEBHOOK_SECRET`; an invalid/missing
 *   signature is rejected 400 and nothing is written.
 * - Every delivered event id is recorded in `WebhookEvent` inside the same
 *   transaction that processes it, so a redelivery / replay / duplicate is a
 *   no-op. Out-of-order events are absorbed by the order-state guards in
 *   `payment-service`.
 * - A webhook can never cause a duplicate stock deduction or ledger movement:
 *   the state guards run each transition at most once, and the Phase 5 movement
 *   idempotency keys are the backstop.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAYMENT_INTENT_EVENT_TYPES = new Set([
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
]);
// Fires when a refund's own status changes (e.g. pending -> succeeded/failed)
// — the async reconciliation path for a refund that wasn't settled at
// request time. The refund object is already fully present on the event, so
// this never needs a follow-up API call.
const REFUND_EVENT_TYPES = new Set(["refund.updated"]);
const HANDLED = new Set([...PAYMENT_INTENT_EVENT_TYPES, ...REFUND_EVENT_TYPES]);

export async function POST(request: Request): Promise<Response> {
  if (!isStripeConfigured()) {
    logError("stripe_webhook.not_configured"); // deployment problem: Stripe is never told 2xx, so it retries
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");
  const gateway = getPaymentGateway();

  let event;
  try {
    event = gateway.parseWebhook(rawBody, signature);
  } catch (error) {
    // Category only: the verifier's message and the signature header are never logged.
    logWarn("stripe_webhook.rejected", {
      reason: error instanceof WebhookSignatureError ? "invalid_signature" : "unparseable",
    });
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }

  // Fast-path duplicate check (the transactional insert below is the real guard).
  const seen = await prisma.webhookEvent.findUnique({ where: { eventId: event.id } });
  if (seen) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  if (!HANDLED.has(event.type)) {
    try {
      await prisma.webhookEvent.create({
        data: { eventId: event.id, type: event.type, processedAt: new Date() },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    await recordAudit(
      {
        action: AUDIT_ACTIONS.PAYMENT_WEBHOOK_UNHANDLED,
        metadata: { eventId: event.id, type: event.type },
      },
      prisma,
    );
    return NextResponse.json({ received: true, handled: false });
  }

  if (REFUND_EVENT_TYPES.has(event.type)) {
    const refundObject = event.object as {
      id?: string;
      status?: string;
      amount?: number;
      currency?: string;
      payment_intent?: string | { id: string } | null;
      metadata?: Record<string, string> | null;
    };
    if (!refundObject.id) {
      await prisma.webhookEvent.create({
        data: { eventId: event.id, type: event.type, processedAt: new Date() },
      });
      return NextResponse.json({ received: true, handled: false });
    }
    const status: RefundProviderStatus =
      refundObject.status === "succeeded" ||
      refundObject.status === "pending" ||
      refundObject.status === "failed" ||
      refundObject.status === "canceled"
        ? refundObject.status
        : "pending";
    const paymentIntentId =
      typeof refundObject.payment_intent === "string"
        ? refundObject.payment_intent
        : (refundObject.payment_intent?.id ?? "");

    try {
      await prisma.$transaction(
        async (tx) => {
          // Same concurrency guard as the payment-intent path below: recording
          // the event id inside the transaction means a racing redelivery
          // hits the unique index and rolls back.
          await tx.webhookEvent.create({
            data: { eventId: event.id, type: event.type, processedAt: new Date() },
          });
          await reconcileRefundFromEventTx(tx, {
            id: refundObject.id!,
            status,
            amountCents: refundObject.amount ?? 0,
            currency: refundObject.currency ?? "",
            paymentIntentId,
            metadata: refundObject.metadata ?? null,
          });
        },
        { timeout: 20_000, maxWait: 10_000 },
      );
      return NextResponse.json({ received: true, handled: true });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return NextResponse.json({ received: true, duplicate: true });
      }
      logError("stripe_webhook.processing_failed", {
        eventId: event.id,
        eventType: event.type,
        stage: "refund_transaction",
        ...errorFields(error),
      });
      return NextResponse.json({ error: "processing_error" }, { status: 500 });
    }
  }

  // Re-fetch the PaymentIntent from Stripe (authoritative status + card details).
  const piId = (event.object as { id?: string }).id;
  if (!piId) {
    await prisma.webhookEvent.create({
      data: { eventId: event.id, type: event.type, processedAt: new Date() },
    });
    return NextResponse.json({ received: true, handled: false });
  }
  let pi;
  try {
    pi = await gateway.retrievePaymentIntent(piId);
  } catch (error) {
    // Previously this escaped as an unhandled exception (Next.js answered 500, nothing recorded).
    // Same status — Stripe retries the delivery — but now it leaves a structured, secret-free record.
    logError("stripe_webhook.processing_failed", {
      eventId: event.id,
      eventType: event.type,
      stage: "retrieve_payment_intent",
      ...errorFields(error),
    });
    return NextResponse.json({ error: "processing_error" }, { status: 500 });
  }

  try {
    const { result, audit } = await prisma.$transaction(
      async (tx) => {
        // Recording the event id inside the transaction is the concurrency guard:
        // a racing delivery of the same event hits the unique index and rolls back.
        await tx.webhookEvent.create({
          data: { eventId: event.id, type: event.type, processedAt: new Date() },
        });

        if (event.type === "payment_intent.succeeded") {
          return finalizeFromPaymentIntentTx(tx, pi, "webhook");
        }
        return finalizeFailureTx(
          tx,
          pi,
          "webhook",
          event.type === "payment_intent.canceled"
            ? "PaymentIntent canceled"
            : (pi.lastError ?? "payment failed"),
        );
      },
      { timeout: 20_000, maxWait: 10_000 },
    );

    if (audit) {
      await recordAudit(
        {
          action: audit.action,
          entityType: "Order",
          entityId: audit.entityId,
          metadata: audit.metadata,
        },
        prisma,
      );
    }
    // Post-commit, best-effort (Phase 8) — never throws, never blocks or
    // undoes the already-committed payment; see `kickEmailDispatch`.
    if (result.outcome === "paid") {
      await kickEmailDispatch(prisma);
    }
    return NextResponse.json({ received: true, handled: true });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // A concurrent delivery of this exact event won the race — it is handled.
      return NextResponse.json({ received: true, duplicate: true });
    }
    logError("stripe_webhook.processing_failed", {
      eventId: event.id,
      eventType: event.type,
      stage: "payment_transaction",
      ...errorFields(error),
    });
    // 500 → Stripe retries. The transaction rolled back, including the event id.
    return NextResponse.json({ error: "processing_error" }, { status: 500 });
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
