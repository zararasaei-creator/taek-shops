import {
  type Currency,
  PaymentStatus,
  PaymentTransactionStatus,
  Prisma,
  RefundStatus,
  type PrismaClient,
  type Refund,
} from "@prisma/client";
import { z } from "zod";

import { prisma } from "@/server/db/client";
import { requirePermission, type AuthUser } from "@/server/auth/authorization";
import { recordAudit } from "@/server/audit/audit-service";
import { AUDIT_ACTIONS } from "@/server/audit/actions";
import { CatalogValidationError, NotFoundError } from "@/server/catalog/errors";
import { MAX_PRICE_CENTS } from "@/lib/validation/catalog";
import { getPaymentGateway, PaymentGatewayError } from "@/server/domain/payments";
import type { PaymentGateway, RefundProviderStatus, RefundResult } from "@/server/domain/payments";

/**
 * Refund orchestration (Phase 8).
 *
 * Reuses the Phase 7 payment boundary unchanged — `PaymentGateway` gained
 * `refund`/`retrieveRefund`, nothing about `createPaymentIntent`,
 * `retrievePaymentIntent`, or webhook signature verification changed.
 *
 * Authoritative rules:
 * - MANAGER/ADMIN only (`order.write`, the same permission
 *   `order-management-service.ts` already gates writes on).
 * - One `Refund` row per REQUEST (not per settled amount) — a `Payment` can
 *   have several over time. `Payment.refundedCents` only ever reflects
 *   SUCCEEDED rows; PENDING rows reserve part of the refundable balance so
 *   two concurrent requests can never together exceed the captured amount.
 * - The balance check + row creation happen in ONE short transaction (a
 *   `SELECT ... FOR UPDATE` on the `Payment` row serializes concurrent
 *   requests against it); the network call to the provider happens AFTER
 *   that transaction commits — never inside it.
 * - Idempotency key is caller-supplied and stable per attempt: an exact
 *   retry (double click, resubmit) with the SAME key is a pure read of the
 *   existing `Refund` row — no second provider call, ever.
 * - A provider call that throws an *ambiguous* error (network/timeout — we
 *   don't know if it went through) leaves the `Refund` row PENDING for
 *   reconciliation; only a *definitive* provider decline marks it FAILED.
 *   Never OrderStatus, never inventory — refunding money is independent of
 *   returning goods (that's `FulfillmentStatus`, unaffected here).
 */

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;
type Actor = AuthUser | null | undefined;

interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

const refundRequestSchema = z.object({
  amountCents: z.number().int().min(1).max(MAX_PRICE_CENTS),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().trim().min(8).max(200),
});
export type RequestRefundInput = z.input<typeof refundRequestSchema>;

// ---------------------------------------------------------------------------
// Refundable-balance summary
// ---------------------------------------------------------------------------

export interface RefundSummary {
  capturedCents: number;
  confirmedRefundedCents: number;
  pendingRefundedCents: number;
  remainingCents: number;
  currency: string;
}

export function computeRefundSummary(
  payment: { amountCents: number; refundedCents: number; currency: string },
  pendingRefundedCents: number,
): RefundSummary {
  const remainingCents = Math.max(
    payment.amountCents - payment.refundedCents - pendingRefundedCents,
    0,
  );
  return {
    capturedCents: payment.amountCents,
    confirmedRefundedCents: payment.refundedCents,
    pendingRefundedCents,
    remainingCents,
    currency: payment.currency,
  };
}

async function sumPendingRefunds(db: Pick<Db, "refund">, paymentId: string): Promise<number> {
  const agg = await db.refund.aggregate({
    where: { paymentId, status: RefundStatus.PENDING },
    _sum: { amountCents: true },
  });
  return agg._sum.amountCents ?? 0;
}

export async function getRefundSummaryForOrder(
  actor: Actor,
  orderId: string,
  db: Db = prisma,
): Promise<RefundSummary | null> {
  requirePermission(actor, "order.read");
  const payment = await db.payment.findUnique({ where: { orderId } });
  if (!payment) return null;
  const pendingRefundedCents = await sumPendingRefunds(db, payment.id);
  return computeRefundSummary(payment, pendingRefundedCents);
}

// ---------------------------------------------------------------------------
// Request a refund
// ---------------------------------------------------------------------------

interface LockedPayment {
  id: string;
  provider: string;
  providerPaymentId: string | null;
  status: PaymentTransactionStatus;
  amountCents: number;
  currency: Currency;
  refundedCents: number;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** Postgres deadlock (two transactions each waiting on the other's lock). */
function isDeadlock(error: unknown): boolean {
  return error instanceof Error && /deadlock detected/i.test(error.message);
}

/**
 * A deadlock victim's transaction is rolled back in full — nothing partial
 * persists — so retrying the exact same (idempotent) work is always safe.
 * Postgres's own documentation recommends exactly this: catch the deadlock
 * and retry. Bounded so a genuine, non-transient failure still surfaces.
 */
async function withDeadlockRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !isDeadlock(error)) throw error;
    }
  }
}

async function lockPaymentForOrder(tx: Tx, orderId: string): Promise<LockedPayment> {
  const rows = await tx.$queryRaw<LockedPayment[]>(Prisma.sql`
    SELECT "id", "provider", "providerPaymentId", "status", "amountCents", "currency", "refundedCents"
    FROM "Payment"
    WHERE "orderId" = ${orderId}
    FOR UPDATE
  `);
  const row = rows[0];
  if (!row) throw new NotFoundError("Payment for order", orderId);
  return row;
}

const REFUNDABLE_PAYMENT_STATUSES = new Set<PaymentTransactionStatus>([
  PaymentTransactionStatus.CAPTURED,
  PaymentTransactionStatus.PARTIALLY_REFUNDED,
]);

export async function requestRefund(
  actor: Actor,
  orderId: string,
  input: unknown,
  meta: Meta = {},
  db: Db = prisma,
  gateway: PaymentGateway = getPaymentGateway(),
): Promise<Refund> {
  const authed = requirePermission(actor, "order.write");
  const data = refundRequestSchema.parse(input);

  // Exact retry of the same attempt: a pure read, never a new provider call.
  const existing = await db.refund.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
  if (existing) return existing;

  // Two concurrent requests with the SAME idempotency key contend for the
  // SAME Payment row lock AND the SAME unique index entry. Exactly one wins;
  // the other must come back with the winner's row, never a second provider
  // call. A raw Postgres deadlock (killed before either side committed) is
  // retried from scratch — safe, since nothing partial ever persists from an
  // aborted transaction.
  type CreateOutcome =
    | { kind: "created"; refund: Refund; providerPaymentId: string; orderNumber: string }
    | { kind: "already_exists"; refund: Refund };
  let outcome: CreateOutcome | null = null;
  await withDeadlockRetry(async () => {
    try {
      outcome = await db.$transaction(async (tx) => {
        const order = await tx.order.findUnique({
          where: { id: orderId },
          select: { id: true, orderNumber: true },
        });
        if (!order) throw new NotFoundError("Order", orderId);

        const payment = await lockPaymentForOrder(tx, orderId);
        if (!payment.providerPaymentId) {
          throw new CatalogValidationError("This order has no captured payment to refund.");
        }
        if (!REFUNDABLE_PAYMENT_STATUSES.has(payment.status)) {
          throw new CatalogValidationError(
            `A payment with status ${payment.status} cannot be refunded.`,
          );
        }

        const pendingRefundedCents = await sumPendingRefunds(tx, payment.id);
        const summary = computeRefundSummary(payment, pendingRefundedCents);
        if (data.amountCents > summary.remainingCents) {
          throw new CatalogValidationError(
            `Refund amount exceeds the refundable balance (${(summary.remainingCents / 100).toFixed(2)} ${payment.currency} remaining).`,
          );
        }

        const row = await tx.refund.create({
          data: {
            paymentId: payment.id,
            amountCents: data.amountCents,
            currency: payment.currency,
            status: RefundStatus.PENDING,
            reason: data.reason,
            idempotencyKey: data.idempotencyKey,
            provider: payment.provider,
            requestedById: authed.id,
          },
        });

        return {
          kind: "created" as const,
          refund: row,
          providerPaymentId: payment.providerPaymentId,
          orderNumber: order.orderNumber,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const winner = await db.refund.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
        if (winner) {
          outcome = { kind: "already_exists", refund: winner };
          return;
        }
      }
      throw error;
    }
  });

  // Someone else's request with this exact key already exists — that row IS
  // the answer; we never reach (or repeat) the provider call.
  const finalOutcome = outcome!;
  if (finalOutcome.kind === "already_exists") return finalOutcome.refund;
  const { refund, providerPaymentId, orderNumber } = finalOutcome;

  await recordAudit(
    {
      action: AUDIT_ACTIONS.REFUND_REQUESTED,
      actorUserId: authed.id,
      entityType: "Order",
      entityId: orderId,
      metadata: {
        orderNumber,
        refundId: refund.id,
        amountCents: data.amountCents,
        currency: refund.currency,
        reason: data.reason,
      },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
    db,
  );

  // The network call happens OUTSIDE any open transaction.
  try {
    const result = await gateway.refund({
      paymentIntentId: providerPaymentId,
      amountCents: data.amountCents,
      idempotencyKey: data.idempotencyKey,
      metadata: { taekShopsRefundId: refund.id },
    });
    return await applyRefundOutcome(db, refund.id, orderId, result, meta);
  } catch (error) {
    const ambiguous = error instanceof PaymentGatewayError ? error.ambiguous : true;
    const message = error instanceof Error ? error.message : String(error);
    // Ambiguous: leave PENDING — we don't know if the provider processed it.
    // Definitive decline: FAILED, audited, never retried with the same key.
    const updated = await db.refund.update({
      where: { id: refund.id },
      data: {
        status: ambiguous ? RefundStatus.PENDING : RefundStatus.FAILED,
        errorMessage: message.slice(0, 500),
      },
    });
    if (!ambiguous) {
      await recordAudit(
        {
          action: AUDIT_ACTIONS.REFUND_FAILED,
          actorUserId: authed.id,
          entityType: "Order",
          entityId: orderId,
          metadata: { orderNumber, refundId: refund.id, reason: message },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
        db,
      );
    }
    return updated;
  }
}

// ---------------------------------------------------------------------------
// Applying a provider outcome — shared by the request path, manual
// reconciliation, and the refund webhook. Idempotent: a refund already in a
// terminal state (SUCCEEDED/FAILED) is never re-applied, so duplicate or
// out-of-order provider events are safe no-ops.
// ---------------------------------------------------------------------------

function mapProviderStatus(status: RefundProviderStatus): RefundStatus | null {
  if (status === "succeeded") return RefundStatus.SUCCEEDED;
  if (status === "failed" || status === "canceled") return RefundStatus.FAILED;
  return null; // "pending" — no local state change yet.
}

/**
 * Apply a provider's refund result to the local `Refund` row, composable
 * inside a caller's transaction. Only when it just SUCCEEDED for the first
 * time does this roll the amount into `Payment.refundedCents` and recompute
 * `Payment.status` / `Order.paymentStatus`. Never touches `OrderStatus`,
 * `FulfillmentStatus`, or inventory — refunding money is independent of
 * returning goods. Idempotent: a refund already in a terminal state
 * (SUCCEEDED/FAILED) is a no-op, so duplicate or out-of-order provider
 * events/retries are always safe.
 */
export async function applyRefundOutcomeTx(
  tx: Tx,
  refundId: string,
  orderId: string,
  result: RefundResult,
  meta: Meta = {},
): Promise<Refund> {
  const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
  if (refund.status !== RefundStatus.PENDING) return refund;

  const nextStatus = mapProviderStatus(result.status);
  if (nextStatus === null) {
    // Still pending — just record the provider reference once known.
    return tx.refund.update({ where: { id: refundId }, data: { providerRefundId: result.id } });
  }

  const updated = await tx.refund.update({
    where: { id: refundId },
    data: {
      status: nextStatus,
      providerRefundId: result.id,
      errorMessage: nextStatus === RefundStatus.FAILED ? "Provider declined the refund." : null,
    },
  });

  if (nextStatus === RefundStatus.SUCCEEDED) {
    const payment = await tx.payment.update({
      where: { id: refund.paymentId },
      data: { refundedCents: { increment: refund.amountCents } },
    });
    const fullyRefunded = payment.refundedCents >= payment.amountCents;
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: fullyRefunded
          ? PaymentTransactionStatus.REFUNDED
          : PaymentTransactionStatus.PARTIALLY_REFUNDED,
      },
    });
    await tx.order.update({
      where: { id: orderId },
      data: {
        paymentStatus: fullyRefunded ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED,
      },
    });
    await recordAudit(
      {
        action: AUDIT_ACTIONS.REFUND_SUCCEEDED,
        entityType: "Order",
        entityId: orderId,
        metadata: {
          refundId,
          amountCents: refund.amountCents,
          currency: refund.currency,
          fullyRefunded,
        },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
      tx,
    );
  } else {
    await recordAudit(
      {
        action: AUDIT_ACTIONS.REFUND_FAILED,
        entityType: "Order",
        entityId: orderId,
        metadata: { refundId, amountCents: refund.amountCents, reason: "provider_declined" },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
      tx,
    );
  }

  return updated;
}

/** Open a transaction, then apply the outcome — for callers outside one already. */
export async function applyRefundOutcome(
  db: Db,
  refundId: string,
  orderId: string,
  result: RefundResult,
  meta: Meta = {},
): Promise<Refund> {
  return withDeadlockRetry(() =>
    db.$transaction((tx) => applyRefundOutcomeTx(tx, refundId, orderId, result, meta)),
  );
}

/**
 * Stripe only guarantees an idempotency key is honoured for a MINIMUM of 24
 * hours; past that window a reused key can be pruned and a "retry" becomes a
 * genuinely new request (https://docs.stripe.com/api/idempotent_requests:
 * "We generate a new request if a key is reused after the original is
 * pruned."). Re-issuing `gateway.refund()` with the same key beyond that
 * window is therefore NOT provably safe — if the original attempt actually
 * reached Stripe, this could create a real second refund. A conservative
 * 12-hour cutoff (half of Stripe's documented minimum) leaves margin for
 * clock skew and Stripe's own "at least" wording.
 */
const IDEMPOTENCY_SAFE_RETRY_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * Reconcile a refund that's still PENDING locally — via provider status
 * retrieval when we already know its provider id, or (when we don't — the
 * genuinely ambiguous case, where a prior call to `gateway.refund` may or
 * may not have reached the provider) by re-issuing the SAME idempotent
 * request, but ONLY within the safe retry window above. Beyond it, the
 * outcome must be confirmed some other way (the Stripe Dashboard, or a
 * `refund.updated` webhook now linked via provider metadata — see
 * `reconcileRefundFromEventTx`) before any further action, since a blind
 * resubmit is no longer provably a no-op.
 */
export async function reconcileRefund(
  actor: Actor,
  refundId: string,
  db: Db = prisma,
  gateway: PaymentGateway = getPaymentGateway(),
): Promise<Refund> {
  requirePermission(actor, "order.write");
  const refund = await db.refund.findUnique({
    where: { id: refundId },
    include: { payment: { select: { orderId: true, providerPaymentId: true } } },
  });
  if (!refund) throw new NotFoundError("Refund", refundId);
  if (refund.status !== RefundStatus.PENDING) return refund;

  if (refund.providerRefundId) {
    const result = await gateway.retrieveRefund(refund.providerRefundId);
    return applyRefundOutcome(db, refund.id, refund.payment.orderId, result);
  }

  const ageMs = Date.now() - refund.createdAt.getTime();
  if (ageMs > IDEMPOTENCY_SAFE_RETRY_WINDOW_MS) {
    throw new CatalogValidationError(
      "This refund's outcome was never confirmed and it is now outside the safe window to " +
        "automatically retry (Stripe's idempotency keys are only guaranteed for a minimum of " +
        "24 hours). Check the Stripe Dashboard for a refund matching this payment before taking " +
        "any further action — do not request a new refund without first confirming one doesn't " +
        "already exist.",
    );
  }

  // The retry must reuse the SAME idempotency key and IDENTICAL request
  // parameters the original attempt would have sent — never a guess. That
  // evidence is the persisted `Refund`/`Payment` rows themselves:
  // `amountCents`, `idempotencyKey`, and `payment.providerPaymentId` are
  // never mutated by any code path after creation (only `status`,
  // `providerRefundId`, and `errorMessage` are ever updated — see
  // `applyRefundOutcomeTx`), and `metadata.taekShopsRefundId` is
  // deterministically `refund.id`, itself immutable. So re-reading these
  // fields now reconstructs exactly what was sent originally — this is
  // never a fresh/different request. If that evidence were ever missing
  // (a payment somehow lacking its provider reference), retrying would be
  // a guess, so this refuses rather than sending a malformed request.
  if (!refund.payment.providerPaymentId) {
    throw new CatalogValidationError(
      "This payment has no recorded provider reference — cannot safely retry. Reconcile manually.",
    );
  }
  const result = await gateway.refund({
    paymentIntentId: refund.payment.providerPaymentId,
    amountCents: refund.amountCents,
    idempotencyKey: refund.idempotencyKey,
    metadata: { taekShopsRefundId: refund.id },
  });
  return applyRefundOutcome(db, refund.id, refund.payment.orderId, result);
}

/**
 * Reconcile from a signature-verified `refund.updated` webhook event.
 *
 * Primary lookup is by the provider's own refund id. That id is only stored
 * locally once a `gateway.refund()` call returns successfully — an
 * *ambiguous* (network/timeout) call throws before we ever learn it, even
 * though Stripe may have created the refund anyway. Without a fallback, the
 * FIRST `refund.updated` event for such a refund would silently no-op here
 * (recorded as a handled `WebhookEvent`, so it can never be redelivered),
 * leaving the refund recoverable only via a manual "Check status" click.
 *
 * The fallback closes that gap: `requestRefund`/`reconcileRefund` attach our
 * local `Refund.id` as `taekShopsRefundId` in the provider's own refund
 * metadata (present on the object from the moment Stripe creates it, so it
 * survives even when OUR response never arrives). When the primary lookup
 * misses, we read that id back out of the event and look up the candidate
 * row directly — but metadata is an opaque string we don't otherwise trust,
 * so before applying anything we verify the candidate is still PENDING (not
 * already linked or settled) and that the event's amount, currency, and
 * payment intent all match what THAT row actually expects. Any mismatch is
 * treated as "no reliable link" and left as a no-op, never a guess.
 *
 * Composable inside the webhook route's own transaction (which already
 * provides the `WebhookEvent` dedup/concurrency guard), and reuses the exact
 * same `applyRefundOutcomeTx` the request path and manual reconciliation
 * use — never a re-implemented copy of that logic.
 */
export async function reconcileRefundFromEventTx(
  tx: Tx,
  event: {
    id: string;
    status: RefundProviderStatus;
    amountCents: number;
    currency: string;
    paymentIntentId: string;
    metadata: Record<string, string> | null;
  },
): Promise<void> {
  const byProviderId = await tx.refund.findUnique({
    where: { provider_providerRefundId: { provider: "stripe", providerRefundId: event.id } },
    select: { id: true, payment: { select: { orderId: true } } },
  });

  let target = byProviderId;
  if (!target) {
    const localRefundId = event.metadata?.taekShopsRefundId;
    if (!localRefundId) return;

    const candidate = await tx.refund.findUnique({
      where: { id: localRefundId },
      select: {
        id: true,
        status: true,
        amountCents: true,
        currency: true,
        payment: { select: { orderId: true, providerPaymentId: true } },
      },
    });
    const matches =
      candidate !== null &&
      candidate.status === RefundStatus.PENDING &&
      candidate.amountCents === event.amountCents &&
      candidate.currency.toLowerCase() === event.currency.toLowerCase() &&
      candidate.payment.providerPaymentId === event.paymentIntentId;
    if (!matches) return;
    target = { id: candidate.id, payment: { orderId: candidate.payment.orderId } };
  }

  await applyRefundOutcomeTx(tx, target.id, target.payment.orderId, {
    id: event.id,
    status: event.status,
    amountCents: event.amountCents,
    paymentIntentId: event.paymentIntentId,
  });
}
