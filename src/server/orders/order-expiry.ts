import {
  Currency,
  OrderStatus,
  PaymentStatus,
  PaymentTransactionStatus,
  Prisma,
  type PrismaClient,
} from "@prisma/client";

import { prisma } from "@/server/db/client";
import { recordAudit } from "@/server/audit/audit-service";
import { AUDIT_ACTIONS } from "@/server/audit/actions";
import { serverEnv } from "@/server/config/env";
import { PAYMENT_PROVIDER } from "@/server/payments/config";
import { applyOrderStatusTransitionTx, lockOrderRow } from "@/server/orders/order-inventory";
import {
  CLAIM_INFLIGHT_WINDOW_MS,
  IDEMPOTENT_RECOVERY_MAX_AGE_MS,
  claimEra,
  claimsActiveSince,
  createOrRecoverPaymentIntent,
  finalizeFromPaymentIntent,
} from "@/server/orders/payment-service";
import { getPaymentGateway, PaymentGatewayError } from "@/server/domain/payments";
import type { PaymentGateway, PaymentIntentView } from "@/server/domain/payments";
import { ConflictError } from "@/server/catalog/errors";

/**
 * Abandoned-checkout reservation recovery (launch-prep milestone).
 *
 * `placeOrder` (Phase 6) reserves stock the moment a `PENDING` order is
 * created, BEFORE any payment attempt. Nothing previously released that
 * reservation for a customer who simply never completes or cancels payment.
 * This module is the missing path: a repeatable sweep
 * (`runOrderExpirySweep`, driven by `scripts/expire-abandoned-orders.ts` —
 * not scheduled anywhere yet) that resolves stale `PENDING`/`UNPAID` orders.
 *
 * **The safety invariant this module and its two counterparts enforce**
 * (`startPayment` in `payment-service.ts`; `applyOrderStatusTransitionTx`
 * in `order-inventory.ts`, which the admin "Cancel" action also uses):
 * stock is never released for an order while a payment against it could
 * still be payable or succeed, and a payment is never started against an
 * order whose stock has been released.
 *
 * **How it is enforced — durable coordination, not timing.** Every provider
 * PaymentIntent creation is preceded by a COMMITTED `Payment` "claim" row
 * (`providerPaymentId: null`), written inside a transaction that holds
 * `SELECT ... FOR UPDATE` on the `Order` row (`lockOrderRow`). Every
 * cancellation that would release stock takes the SAME lock first and
 * re-reads current state under it. PostgreSQL therefore serializes the two:
 * - cancellation first: the claim transaction acquires the lock afterwards,
 *   sees the order is no longer `PENDING`, and aborts BEFORE any provider
 *   call — payment creation never starts;
 * - claim first: the cancellation sees the committed claim and refuses (the
 *   sweep reports a `preserved_*` outcome; `applyOrderStatusTransitionTx`
 *   throws `ConflictError`, which is what the admin path gets) until the
 *   claim is authoritatively reconciled.
 * Because the claim is committed BEFORE provider I/O, "a provider
 * PaymentIntent exists but no local row says so" cannot arise from this
 * code: a crash after provider success leaves the claim row, never nothing.
 * That — not a provider search — is what makes a missing local `Payment`
 * row meaningful for orders whose payment attempts ran on this code.
 * `findPaymentIntentForOrder` (Stripe Search, documented as eventually
 * consistent: docs.stripe.com/search "Data freshness") remains only as a
 * best-effort net for attempts that predate the claim mechanism; a search
 * miss is NEVER treated as proof of absence on its own.
 *
 * **Reuses existing idempotent reconciliation; adds no stock-release
 * implementation.** `finalizeFromPaymentIntent` (shared with the webhook and
 * the return page) and `applyOrderStatusTransitionTx` do every actual state
 * change and inventory release; `releaseReservationTx`'s per-line
 * idempotency keys keep release exactly-once under repeated or concurrent
 * runs. Provider network calls never happen inside a database transaction.
 *
 * **What the sweep does per candidate** (`PENDING`/`UNPAID`, older than
 * `ORDER_EXPIRY_MINUTES`, default 60 — a floor, not a promise of action):
 * - no `Payment` row: confirm nothing at the provider, then cancel under the
 *   lock (re-checking for a claim that appeared in the meantime);
 * - linked PaymentIntent: ask the provider for current truth; `succeeded` /
 *   `canceled` finalize through the shared path; `processing` is left alone;
 *   still-payable is cancelled AT THE PROVIDER and released only once the
 *   provider confirms (a refusal because it just succeeded is re-reconciled,
 *   not assumed);
 * - unresolved claim (`providerPaymentId: null`) — recovery is age-banded by
 *   the provider's idempotency retention (see `CLAIM_INFLIGHT_WINDOW_MS` /
 *   `IDEMPOTENT_RECOVERY_MAX_AGE_MS` in `payment-service.ts`):
 *     young      -> leave alone (the original provider call may be running);
 *     in window  -> re-issue the create with the same idempotency key, then
 *                   re-retrieve (a replay returns the ORIGINAL body, whose
 *                   status can be stale) and reconcile;
 *     too old    -> never re-issue (could duplicate); adopt only a
 *                   provider-side search hit after a fresh retrieve; a miss
 *                   preserves stock and is reported for manual recovery.
 * - no `Payment` row AND the order is not provably post-claim (it predates
 *   `PAYMENT_CLAIMS_ACTIVE_SINCE`, or that boundary is unset): a search hit
 *   is reconciled as above, but a MISS never authorizes a release —
 *   `preserved_legacy_needs_review` / `preserved_claims_cutoff_unconfigured`;
 * - any ambiguous provider failure (network, timeout, 409
 *   `idempotency_key_in_use`): nothing is touched; the next run retries.
 *
 * **Unresolved, stated plainly**: (1) a claim older than the idempotency
 * window whose provider-side record cannot be found by search stays
 * unresolved and keeps its reservation until an operator resolves it
 * (runbook in the roadmap) — failing safe, at the cost of stuck stock;
 * (2) `order.expired` audit rows are not exactly-once under concurrent runs
 * (inventory release still is); (3) legacy (pre-claim) orders with no local
 * payment record are preserved and flagged, never auto-released on a search
 * miss; (4) no scheduler is activated — see the CLI script. Admin
 * cancellation is provider-aware (`order-cancellation.ts`) and shares
 * `reconcileLinkedPayment` with this sweep.
 */

type Db = PrismaClient;

const TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 } as const;

/**
 * Provider statuses where cancellation is safe to actively request.
 * `"processing"` is deliberately excluded — handled as its own preserved
 * case, never grouped with these.
 */
const ACTIVELY_CANCELABLE_STATUSES = new Set([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
]);

export interface ExpiryPolicy {
  /** Minimum age (ms) a PENDING/UNPAID order must reach before this sweep considers it at all. */
  minAgeMs: number;
  /**
   * The rollout boundary (`PAYMENT_CLAIMS_ACTIVE_SINCE`); `null`/absent means
   * UNCONFIGURED, which fails closed (see `claimEra`): a no-`Payment`-row
   * order with no provider search hit is preserved and flagged, never
   * cancelled. Only orders created at/after the boundary are provably
   * never-attempted on that evidence.
   */
  claimsActiveSince?: Date | null;
}

export function defaultExpiryPolicy(): ExpiryPolicy {
  return { minAgeMs: serverEnv.ORDER_EXPIRY_MINUTES * 60_000, claimsActiveSince: claimsActiveSince() };
}

export type ExpiryOutcome =
  /** No PaymentIntent locally or at the provider — genuinely never attempted; cancelled directly. */
  | "cancelled_no_payment_intent"
  /** The provider confirmed cancellation (already canceled, or cancelled by this sweep); reservation released. */
  | "cancelled_provider_confirmed"
  /** The provider reports the payment actually succeeded — reconciled as paid, not released. */
  | "finalized_paid"
  /** An active settlement ("processing") — left untouched regardless of age. */
  | "preserved_processing"
  /** The provider's status is genuinely unknown (network/timeout) — left untouched; retry later. */
  | "preserved_ambiguous"
  /** Resolved by something else (payment, admin, or another sweep run) between the scan and processing. */
  | "already_resolved"
  /**
   * A `Payment` row appeared for this order between this sweep's own
   * "nothing found" decision and its cancellation transaction — a
   * `startPayment` call (or a race-condition retry of one) began in that
   * exact window. Preserved, not cancelled: a real PaymentIntent may now
   * exist (or be about to) that this sweep never checked against. The next
   * sweep will see the `Payment` row and reconcile it as a normal linked
   * payment.
   */
  | "preserved_payment_started"
  /**
   * An unresolved payment-creation claim younger than
   * `CLAIM_INFLIGHT_WINDOW_MS`: the original provider call may still be
   * running. Left strictly alone (nothing created, cancelled, or released).
   */
  | "preserved_claim_in_flight"
  /**
   * An unresolved claim older than the provider's idempotency retention
   * (`IDEMPOTENT_RECOVERY_MAX_AGE_MS`) and no provider-side record could be
   * found. NOT proof that none exists (search is eventually consistent, and
   * re-issuing the create could duplicate it) — stock stays reserved and an
   * operator must resolve it (runbook in the roadmap). Reported by the CLI.
   */
  | "preserved_claim_needs_review"
  /**
   * A LEGACY order (created before durable claims went live) with no local
   * `Payment` row and no provider search hit. A pre-claim `startPayment`
   * could have created a PaymentIntent and crashed before any local write,
   * and Stripe Search is eventually consistent — so a miss is not proof of
   * absence. Stock stays reserved; an operator reconciles it (runbook in the
   * roadmap). Reported by the CLI.
   */
  | "preserved_legacy_needs_review"
  /**
   * Same evidence gap, but `PAYMENT_CLAIMS_ACTIVE_SINCE` is not configured,
   * so it cannot even be said whether the order is legacy. Fails closed:
   * stock stays reserved; configuration and reconciliation are required.
   */
  | "preserved_claims_cutoff_unconfigured"
  /** This candidate's own processing threw — captured, not propagated, so one bad row never aborts the sweep. */
  | "error";

export interface ExpiryItemResult {
  orderId: string;
  orderNumber: string;
  outcome: ExpiryOutcome;
  detail?: string;
}

export interface ExpirySweepResult {
  scanned: number;
  items: ExpiryItemResult[];
}

export interface ExpirySweepHooks {
  /**
   * Test-only injection point. Fires for a no-PaymentIntent candidate after
   * this sweep has confirmed nothing exists locally or at the provider, but
   * BEFORE the cancellation transaction opens — exactly the window a
   * concurrent `startPayment` call could land in (its `createPaymentIntent`
   * succeeding and its `Payment` row write landing in that gap). Lets a
   * test deterministically prove — not just assume — that a payment
   * attempt starting in that exact window is detected and the reservation
   * preserved. Never set outside tests; defaults to a no-op.
   */
  beforeCancelDirectly?: (orderId: string) => Promise<void>;
}

/**
 * Run one sweep. Provider network calls happen OUTSIDE any database
 * transaction (`retrievePaymentIntent`, `findPaymentIntentForOrder`,
 * `cancelPaymentIntent`) — only the local state change these decisions lead
 * to is ever wrapped in a (short) transaction, exactly like
 * `verifyPaymentStatus`'s own existing pattern.
 */
export async function runOrderExpirySweep(
  db: Db = prisma,
  gateway: PaymentGateway = getPaymentGateway(),
  policy: ExpiryPolicy = defaultExpiryPolicy(),
  hooks: ExpirySweepHooks = {},
): Promise<ExpirySweepResult> {
  const cutoff = new Date(Date.now() - policy.minAgeMs);
  const candidates = await db.order.findMany({
    where: {
      status: OrderStatus.PENDING,
      paymentStatus: PaymentStatus.UNPAID,
      createdAt: { lt: cutoff },
    },
    select: { id: true, orderNumber: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const items: ExpiryItemResult[] = [];
  for (const order of candidates) {
    try {
      const outcome = await processExpiryCandidate(
        db,
        gateway,
        order.id,
        order.createdAt,
        policy.claimsActiveSince ?? null,
        hooks,
      );
      items.push({ orderId: order.id, orderNumber: order.orderNumber, outcome });
    } catch (error) {
      if (error instanceof PaymentGatewayError && error.ambiguous) {
        // Unknown provider outcome (network, timeout, 409 key-in-use):
        // nothing was changed; the next run retries.
        items.push({ orderId: order.id, orderNumber: order.orderNumber, outcome: "preserved_ambiguous" });
        continue;
      }
      items.push({
        orderId: order.id,
        orderNumber: order.orderNumber,
        outcome: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { scanned: candidates.length, items };
}

async function processExpiryCandidate(
  db: Db,
  gateway: PaymentGateway,
  orderId: string,
  orderCreatedAt: Date,
  sinceClaims: Date | null,
  hooks: ExpirySweepHooks,
): Promise<ExpiryOutcome> {
  const payment = await db.payment.findUnique({
    where: { orderId },
    select: { providerPaymentId: true, createdAt: true },
  });

  if (payment && payment.providerPaymentId === null) {
    // An UNRESOLVED payment-creation claim — `startPayment` writes this row
    // BEFORE calling the provider, specifically so this sweep can see it.
    // This is never "no payment intent": `cancelDirectly` is not reached.
    return resolveUnresolvedClaim(db, gateway, orderId, payment.createdAt);
  }

  if (!payment) {
    const found = await gateway.findPaymentIntentForOrder(orderId);
    if (!found) {
      // A search miss proves absence ONLY for an order whose payment attempts
      // all ran through the durable claim (`claimEra` === "post_claim").
      // Legacy, or boundary unconfigured: it proves nothing — preserve, flag.
      const era = claimEra(orderCreatedAt, sinceClaims);
      if (era === "unknown") return "preserved_claims_cutoff_unconfigured";
      if (era === "legacy") return "preserved_legacy_needs_review";
      return cancelDirectly(db, orderId, hooks);
    }
    // Stripe's own Search API documentation (docs.stripe.com/search, "Data
    // mismatches") states search results can carry a CACHED status that
    // lags the object's true current state — e.g. a search hit for
    // "requires_capture" can, by the time it's returned, actually be
    // "succeeded". Never act on `found`'s own status for a reconciliation
    // decision; re-fetch it with a real (non-search) retrieve, which has no
    // such staleness caveat, before doing anything else.
    const fresh = await gateway.retrievePaymentIntent(found.id);
    await backfillOrphanedPayment(db, orderId, fresh);
    return reconcileLinkedPayment(db, gateway, orderId, fresh);
  }

  const providerPaymentId = payment.providerPaymentId;
  if (!providerPaymentId) {
    // Unreachable in practice (the two branches above exhaust `!payment`
    // and `providerPaymentId === null`), kept only to satisfy TypeScript's
    // narrowing across the separate `if` blocks above.
    return cancelDirectly(db, orderId, hooks);
  }
  const pi = await gateway.retrievePaymentIntent(providerPaymentId);
  return reconcileLinkedPayment(db, gateway, orderId, pi);
}

export async function reconcileLinkedPayment(
  db: Db,
  gateway: PaymentGateway,
  orderId: string,
  pi: PaymentIntentView,
): Promise<ExpiryOutcome> {
  if (pi.status === "succeeded") {
    const result = await finalizeFromPaymentIntent(pi, "expiry", db, gateway);
    return result.outcome === "paid" ||
      result.outcome === "already_paid" ||
      result.outcome === "late_success"
      ? "finalized_paid"
      : "already_resolved";
  }

  if (pi.status === "canceled") {
    const result = await finalizeFromPaymentIntent(pi, "expiry", db, gateway);
    return result.outcome === "failed" ? "cancelled_provider_confirmed" : "already_resolved";
  }

  if (pi.status === "processing") {
    return "preserved_processing";
  }

  if (!ACTIVELY_CANCELABLE_STATUSES.has(pi.status)) {
    // Covers "requires_capture" — not used by this app's Payment Element
    // flow, but part of the PaymentIntentStatus union; never guess at it.
    return "preserved_processing";
  }

  try {
    const cancelled = await gateway.cancelPaymentIntent(pi.id, `pi-expire-${orderId}`);
    const result = await finalizeFromPaymentIntent(cancelled, "expiry", db, gateway);
    return result.outcome === "failed" ? "cancelled_provider_confirmed" : "already_resolved";
  } catch (error) {
    if (error instanceof PaymentGatewayError && error.ambiguous) {
      return "preserved_ambiguous";
    }
    // A definitive refusal — most plausibly because it had already moved to
    // `succeeded`/`processing` by the time the cancel request reached the
    // provider (a real race, not an error in this sweep). Re-ask for the
    // current truth rather than assuming what the refusal implied, and
    // reconcile against THAT.
    const fresh = await gateway.retrievePaymentIntent(pi.id);
    if (fresh.status === pi.status) {
      // Asked again, got the identical still-payable status back — genuinely
      // stuck, not a race; preserve and retry on a later sweep rather than
      // looping here.
      return "preserved_processing";
    }
    return reconcileLinkedPayment(db, gateway, orderId, fresh);
  }
}

/**
 * Recovery of an unresolved claim, age-banded by the provider's idempotency
 * retention — see `CLAIM_INFLIGHT_WINDOW_MS` / `IDEMPOTENT_RECOVERY_MAX_AGE_MS`
 * in `payment-service.ts` for the policy and its sources. Nothing here ever
 * releases stock directly: every outcome that can lead to a release goes
 * through `reconcileLinkedPayment` (provider-confirmed state only).
 */
async function resolveUnresolvedClaim(
  db: Db,
  gateway: PaymentGateway,
  orderId: string,
  claimCreatedAt: Date,
): Promise<ExpiryOutcome> {
  const age = Date.now() - claimCreatedAt.getTime();

  if (age < CLAIM_INFLIGHT_WINDOW_MS) {
    return "preserved_claim_in_flight";
  }

  if (age < IDEMPOTENT_RECOVERY_MAX_AGE_MS) {
    const order = await db.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { orderNumber: true, totalCents: true, currency: true, customerEmail: true },
    });
    const created = await createOrRecoverPaymentIntent(gateway, {
      orderId,
      orderNumber: order.orderNumber,
      amountCents: order.totalCents,
      currency: order.currency.toLowerCase(),
      receiptEmail: order.customerEmail,
    });
    // A replayed idempotent response is the ORIGINAL body — its status can be
    // stale. Always decide from a fresh, non-replayed retrieve.
    const fresh = await gateway.retrievePaymentIntent(created.id);
    await adoptPaymentIntent(db, orderId, fresh);
    return reconcileLinkedPayment(db, gateway, orderId, fresh);
  }

  // Too old for the provider to be trusted to still remember the key:
  // re-issuing could create a duplicate, so only evidence may resolve this.
  const found = await gateway.findPaymentIntentForOrder(orderId);
  if (!found || found.metadata.orderId !== orderId) {
    // Not proof of absence (search is eventually consistent; the key may
    // have been pruned after a real creation) — preserve and escalate.
    return "preserved_claim_needs_review";
  }
  const fresh = await gateway.retrievePaymentIntent(found.id);
  await adoptPaymentIntent(db, orderId, fresh);
  return reconcileLinkedPayment(db, gateway, orderId, fresh);
}

/**
 * Link a provider PaymentIntent to the order's unresolved claim. Guarded on
 * `providerPaymentId: null` so it can never overwrite an id a concurrent
 * recovery already resolved; if the row already points elsewhere, fail
 * closed (throw — the sweep records an `error`, nothing is released).
 */
async function adoptPaymentIntent(db: Db, orderId: string, pi: PaymentIntentView): Promise<void> {
  const updated = await db.payment.updateMany({
    where: { orderId, providerPaymentId: null },
    data: { providerPaymentId: pi.id },
  });
  if (updated.count > 0) return;
  const current = await db.payment.findUnique({ where: { orderId }, select: { providerPaymentId: true } });
  if (current?.providerPaymentId !== pi.id) {
    throw new ConflictError(
      "Payment record points at a different PaymentIntent than the provider returned.",
      `Order ${orderId}: local ${current?.providerPaymentId ?? "none"}, provider ${pi.id}`,
    );
  }
}

/**
 * Pre-claim-era net: a provider PaymentIntent was found by search but no
 * local `Payment` row exists. Create the row, or — if a claim appeared in
 * the meantime (a `startPayment` call racing this sweep) — adopt into it.
 */
export async function backfillOrphanedPayment(db: Db, orderId: string, pi: PaymentIntentView): Promise<void> {
  try {
    await db.payment.create({
      data: {
        orderId,
        provider: PAYMENT_PROVIDER,
        providerPaymentId: pi.id,
        status: PaymentTransactionStatus.PENDING,
        amountCents: pi.amount,
        // This app only ever creates CAD PaymentIntents.
        currency: Currency.CAD,
      },
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
      throw error;
    }
    await adoptPaymentIntent(db, orderId, pi);
  }
}

/**
 * No PaymentIntent exists locally OR at the provider — genuinely never
 * attempted, as far as this sweep's own checks (one local read, one
 * provider search) could tell. Those checks happened some async work ago —
 * a real-world concern, not a theoretical one: a customer could return to
 * pay on this exact, already-expiry-eligible order at the exact moment this
 * sweep runs.
 *
 * **Durable coordination, not a timing-based re-check.** This acquires the
 * exact same `SELECT ... FOR UPDATE` lock on the `Order` row
 * (`lockOrderRow`, `order-inventory.ts`) that `startPayment`'s
 * payment-creation claim acquires before it writes anything — PostgreSQL
 * guarantees the two transactions serialize through this lock: whichever
 * commits first is authoritative, and the other re-reads that committed
 * state once it can proceed. This function then explicitly checks for ANY
 * `Payment` row at all (resolved or not) before cancelling — not merely an
 * unresolved one — because a `startPayment` call racing this exact sweep
 * could have fully resolved (gotten a real PaymentIntent back from the
 * provider) in the time between this sweep's own EARLIER, now-stale
 * `db.payment.findUnique` check and this transaction actually acquiring the
 * lock; checking only for `providerPaymentId: null` here would miss that
 * already-resolved case entirely. `applyOrderStatusTransitionTx` itself
 * (called below) additionally, independently refuses to release-cancel an
 * order with an unresolved claim specifically — a second, structural
 * backstop protecting the ADMIN cancel path too (which has no equivalent
 * pre-check of its own), not a duplicate of this function's own timing
 * assumption.
 *
 * `hooks.beforeCancelDirectly` is the test-only seam that proves the
 * ordering deterministically: see `ExpirySweepHooks`'s own doc comment.
 */
async function cancelDirectly(db: Db, orderId: string, hooks: ExpirySweepHooks): Promise<ExpiryOutcome> {
  await hooks.beforeCancelDirectly?.(orderId);

  let outcome: ExpiryOutcome;
  try {
    outcome = await db.$transaction(async (tx) => {
      const locked = await lockOrderRow(tx, orderId);
      if (!locked || locked.status !== OrderStatus.PENDING || locked.paymentStatus !== PaymentStatus.UNPAID) {
        return "already_resolved" as const;
      }
      const payment = await tx.payment.findFirst({ where: { orderId }, select: { id: true } });
      if (payment) {
        return "preserved_payment_started" as const;
      }
      // applyOrderStatusTransitionTx re-acquires this SAME lock (already
      // held by this transaction — PostgreSQL permits re-acquiring a lock
      // your own transaction already holds without blocking) and
      // independently re-checks for an unresolved payment claim — a
      // backstop for the admin cancel path, not load-bearing here given the
      // explicit check just above.
      await applyOrderStatusTransitionTx(tx, orderId, OrderStatus.CANCELLED);
      return "cancelled_no_payment_intent" as const;
    }, TX_OPTIONS);
  } catch (error) {
    if (error instanceof ConflictError) {
      return "preserved_payment_started";
    }
    throw error;
  }

  if (outcome === "cancelled_no_payment_intent") {
    const order = await db.order.findUnique({ where: { id: orderId }, select: { orderNumber: true } });
    await recordAudit(
      {
        action: AUDIT_ACTIONS.ORDER_EXPIRED,
        entityType: "Order",
        entityId: orderId,
        metadata: { orderNumber: order?.orderNumber ?? null, reason: "no_payment_intent" },
      },
      db,
    );
  }
  return outcome;
}
