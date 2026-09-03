import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { recordAudit } from "@/server/audit/audit-service";
import { AUDIT_ACTIONS } from "@/server/audit/actions";
import { isStripeConfigured } from "@/server/payments/config";
import { getPaymentGateway, WebhookSignatureError } from "@/server/domain/payments";
import { finalizeFailureTx, finalizeFromPaymentIntentTx } from "@/server/orders/payment-service";

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

const HANDLED = new Set([
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
]);

export async function POST(request: Request): Promise<Response> {
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");
  const gateway = getPaymentGateway();

  let event;
  try {
    event = gateway.parseWebhook(rawBody, signature);
  } catch (error) {
    const message = error instanceof WebhookSignatureError ? error.message : "bad request";
    console.warn("[stripe-webhook] rejected: %s", message);
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

  // Re-fetch the PaymentIntent from Stripe (authoritative status + card details).
  const piId = (event.object as { id?: string }).id;
  if (!piId) {
    await prisma.webhookEvent.create({
      data: { eventId: event.id, type: event.type, processedAt: new Date() },
    });
    return NextResponse.json({ received: true, handled: false });
  }
  const pi = await gateway.retrievePaymentIntent(piId);

  try {
    const { audit } = await prisma.$transaction(
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
    return NextResponse.json({ received: true, handled: true });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // A concurrent delivery of this exact event won the race — it is handled.
      return NextResponse.json({ received: true, duplicate: true });
    }
    console.error("[stripe-webhook] processing error for %s:", event.id, error);
    // 500 → Stripe retries. The transaction rolled back, including the event id.
    return NextResponse.json({ error: "processing_error" }, { status: 500 });
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
