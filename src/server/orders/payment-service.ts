import {
  OrderEmailType,
  OrderStatus,
  PaymentStatus,
  PaymentTransactionStatus,
  Prisma,
  type PrismaClient,
} from "@prisma/client";

import { prisma } from "@/server/db/client";
import { clientEnv, serverEnv } from "@/server/config/env";
import { recordAudit } from "@/server/audit/audit-service";
import { AUDIT_ACTIONS } from "@/server/audit/actions";
import { CatalogValidationError, ConflictError, NotFoundError } from "@/server/catalog/errors";
import { hasPermission, type AuthUser } from "@/server/auth/authorization";
import { applyOrderStatusTransitionTx, lockOrderRow } from "@/server/orders/order-inventory";
import { PAYMENT_PROVIDER } from "@/server/payments/config";
import { getPaymentGateway } from "@/server/domain/payments";
import type { PaymentGateway, PaymentIntentView } from "@/server/domain/payments";
import { enqueueOrderEmailTx, kickEmailDispatch } from "@/server/notifications";

/**
 * Payment orchestration (Phase 7).
 *
 * Authoritative rules:
 * - The charge amount is ALWAYS `Order.totalCents` (frozen at checkout, Phase 6).
 *   The client never supplies or influences an amount, tax, shipping, discount,
 *   currency, or total.
 * - Exactly one `Payment` row per order (`@@unique([orderId])`); the
 *   PaymentIntent is created with a per-order Stripe idempotency key. Together
 *   these make a duplicate charge impossible.
 * - `finalizeFromPaymentIntent*` is the single idempotent completion path, used
 *   by BOTH the signature-verified webhook and the server-side return-page
 *   verification. It never trusts a browser redirect.
 * - On success: `Payment → CAPTURED`, `Order.paymentStatus → PAID`, and (if the
 *   order is still PENDING) `Order.status → CONFIRMED`, which commits the Phase 5
 *   stock reservation. Guarded so it runs at most once — no duplicate stock
 *   deduction or ledger movement.
 * - On failure / cancellation: `Payment → FAILED/CANCELLED`,
 *   `Order.paymentStatus → FAILED`, and (if still PENDING) `Order.status →
 *   CANCELLED`, which releases the reservation.
 */

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;

const TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 } as const;

/**
 * Recovery policy for an UNRESOLVED payment-creation claim (a `Payment` row
 * whose `providerPaymentId` is still null — see `startPayment`).
 *
 * Re-issuing `createPaymentIntent` with the same idempotency key is only a
 * safe way to recover an interrupted creation while Stripe still remembers
 * that key. Stripe states keys "expire out of the system after 24 hours"
 * and that a key reused after pruning "generate[s] a new request"
 * (docs.stripe.com/error-low-level#idempotency, docs.stripe.com/api/
 * idempotent_requests): beyond that, a retry would silently create a
 * SECOND PaymentIntent next to a first one that may well exist. So a claim
 * is split into three age bands, measured from `Payment.createdAt` (the
 * claim is written before the provider is called, so this can only
 * OVER-estimate the key's age — the conservative direction):
 *
 *   age < CLAIM_INFLIGHT_WINDOW_MS      the original provider call may still be
 *                                       running (SDK timeout 20s x 3 attempts
 *                                       plus DB transaction limits) — the
 *                                       expiry sweep leaves it strictly alone.
 *   age < IDEMPOTENT_RECOVERY_MAX_AGE_MS  re-issue with the same key: returns the
 *                                       original PaymentIntent if the first call
 *                                       reached Stripe, creates one if it never
 *                                       did — never a duplicate either way.
 *   otherwise                           NEVER re-issue. Only provider-side
 *                                       evidence may resolve it (search hit,
 *                                       adopted after a fresh retrieve); a miss
 *                                       is not proof of absence (search is
 *                                       eventually consistent), so the
 *                                       reservation is preserved and the claim is
 *                                       surfaced for the documented manual
 *                                       recovery — see the roadmap.
 *
 * **The 12-hour cutoff is a conservative APPLICATION policy, not a Stripe
 * number.** Stripe documents only that idempotency keys are retained for AT
 * LEAST 24 hours and may be pruned after that; it does not say keys are
 * pruned at 12 hours, and nothing here claims it does. 12 h is simply well
 * inside the documented guarantee, so that clock skew, a slow sweep, or a
 * claim timestamp that is slightly off can never be what moves a recovery
 * from "safe same-key replay" into "possible duplicate". Choosing a different
 * value (anything comfortably below 24 h) changes only how long automatic
 * recovery runs before an operator is asked to step in.
 */
export const CLAIM_INFLIGHT_WINDOW_MS = 10 * 60_000;
export const IDEMPOTENT_RECOVERY_MAX_AGE_MS = 12 * 60 * 60_000;

/**
 * The instant from which every payment attempt is guaranteed to have written a
 * durable claim (`PAYMENT_CLAIMS_ACTIVE_SINCE`), or `null` when it has not
 * been configured. See `claimEra` — unset is NOT an assertion that no
 * pre-claim orders exist; it fails closed.
 */
export function claimsActiveSince(): Date | null {
  const raw = serverEnv.PAYMENT_CLAIMS_ACTIVE_SINCE;
  return raw ? new Date(raw) : null;
}

/**
 * Whether "no local `Payment` row" can mean "no payment was ever attempted"
 * for an order:
 *  - `post_claim`  — created at/after the configured rollout boundary: every
 *    attempt wrote a claim first, so a missing row is real evidence of absence;
 *  - `legacy`      — created before it: a pre-claim `startPayment` could create
 *    a provider PaymentIntent and crash before any local write, and Stripe
 *    Search (eventually consistent) cannot rule that out;
 *  - `unknown`     — the boundary is not configured: nothing can be asserted,
 *    so every order is treated as unprovable. The database may well contain
 *    pre-claim orders; missing configuration must never assert otherwise.
 * Only `post_claim` may ever be released on "no row + no search hit".
 * Orders that DO have evidence (a linked `Payment`, or a search hit) are
 * reconciled normally in every era.
 */
export type ClaimEra = "post_claim" | "legacy" | "unknown";

export function claimEra(createdAt: Date, since: Date | null): ClaimEra {
  if (since === null) return "unknown";
  return createdAt.getTime() < since.getTime() ? "legacy" : "post_claim";
}

interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface StartPaymentContext {
  user?: AuthUser | null;
  justPlaced?: boolean;
}

export interface StartPaymentResult {
  orderNumber: string;
  amountCents: number;
  currency: string;
  clientSecret: string;
  publishableKey: string;
  orderStatus: OrderStatus;
  paymentStatus: PaymentStatus;
  /** True when the order was already paid — the caller should show confirmation. */
  alreadyPaid: boolean;
}

const PAYABLE_PI_STATUSES = new Set([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
  "processing",
]);

function assertViewable(order: { userId: string | null }, ctx: StartPaymentContext): void {
  const owns = ctx.user != null && order.userId === ctx.user.id;
  const isStaff = hasPermission(ctx.user, "order.read");
  if (!owns && !isStaff && !ctx.justPlaced) {
    throw new NotFoundError("Order");
  }
}

// ---------------------------------------------------------------------------
// Start payment (create / reuse the PaymentIntent)
// ---------------------------------------------------------------------------

export interface StartPaymentHooks {
  /**
   * Test-only injection point: fires immediately after the payment-creation
   * CLAIM transaction commits (the `Payment` row exists, with
   * `providerPaymentId` still null), before the provider is ever called.
   * Lets a test deterministically attempt a concurrent cancellation (e.g.
   * the abandoned-checkout expiry sweep, or an admin) in exactly the window
   * this claim exists to protect, and assert it is refused — never set
   * outside tests.
   */
  afterClaimCommitted?: () => Promise<void>;
}

/**
 * The ONE place a PaymentIntent is created for an order, using the stable,
 * per-order idempotency key (`pi-create-<orderId>`). Used both by
 * `startPayment`'s own fresh/recovered claim and by
 * `src/server/orders/order-expiry.ts`'s sweep when it finds an unresolved
 * claim (a `Payment` row with `providerPaymentId: null`) left behind by an
 * interrupted earlier `startPayment` call — the documented recovery path
 * for that exact case is "call this again with the same key," never a
 * second, divergent implementation of PaymentIntent creation.
 *
 * Safe to call — WITHIN `IDEMPOTENT_RECOVERY_MAX_AGE_MS` of the claim —
 * whether the original attempt never reached the provider (creates a
 * genuinely new intent), reached it and got a response that was lost
 * locally (returns that original intent, per Stripe's idempotency
 * guarantee — docs.stripe.com/api/idempotent_requests), or is still
 * in-flight from a concurrent caller (Stripe's documented `409 Conflict` /
 * `idempotency_key_in_use` — docs.stripe.com/error-codes — which
 * `stripe.ts`'s `wrap()` classifies `ambiguous: true`, so a caller preserves
 * state and retries rather than treating it as a decline). OUTSIDE that
 * window the provider may no longer remember the key and this call could
 * create a duplicate: callers MUST check the claim's age first.
 *
 * The returned object is the provider's response to THIS call, which for a
 * replay is the ORIGINAL response body — its `status` may be stale. Callers
 * that may be replaying must re-`retrievePaymentIntent` before deciding
 * anything from it.
 */
export async function createOrRecoverPaymentIntent(
  gateway: PaymentGateway,
  order: { orderId: string; orderNumber: string; amountCents: number; currency: string; receiptEmail?: string },
): Promise<PaymentIntentView> {
  return gateway.createPaymentIntent({
    amountCents: order.amountCents,
    currency: order.currency,
    metadata: { orderId: order.orderId, orderNumber: order.orderNumber },
    idempotencyKey: `pi-create-${order.orderId}`,
    description: `Taek Shops order ${order.orderNumber}`,
    receiptEmail: order.receiptEmail,
  });
}

export async function startPayment(
  orderNumber: string,
  ctx: StartPaymentContext,
  meta: Meta = {},
  db: Db = prisma,
  gateway: PaymentGateway = getPaymentGateway(),
  hooks: StartPaymentHooks = {},
): Promise<StartPaymentResult> {
  const publishableKey = clientEnv.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  if (!publishableKey) {
    throw new CatalogValidationError("Payments are not configured.");
  }

  const order = await db.order.findUnique({
    where: { orderNumber },
    select: {
      id: true,
      orderNumber: true,
      userId: true,
      status: true,
      paymentStatus: true,
      totalCents: true,
      currency: true,
      customerEmail: true,
    },
  });
  if (!order) throw new NotFoundError("Order", orderNumber);
  assertViewable(order, ctx);

  const currency = order.currency.toLowerCase();

  if (order.paymentStatus === PaymentStatus.PAID) {
    return {
      orderNumber,
      amountCents: order.totalCents,
      currency,
      clientSecret: "",
      publishableKey,
      orderStatus: order.status,
      paymentStatus: order.paymentStatus,
      alreadyPaid: true,
    };
  }
  if (order.status !== OrderStatus.PENDING || order.paymentStatus !== PaymentStatus.UNPAID) {
    throw new CatalogValidationError("This order can no longer be paid.");
  }

  const existing = await db.payment.findUnique({ where: { orderId: order.id } });

  // Reuse a live PaymentIntent if the local claim already resolved to one.
  if (existing?.providerPaymentId) {
    const pi = await gateway.retrievePaymentIntent(existing.providerPaymentId);
    return finishStartPayment(pi, order, orderNumber, currency, publishableKey, db, gateway);
  }

  // An unresolved claim too old for its idempotency key to still be
  // remembered by the provider (see `IDEMPOTENT_RECOVERY_MAX_AGE_MS`) must
  // NOT be retried here: re-issuing the create call could mint a second
  // PaymentIntent beside a first one that may exist. Fail closed — no
  // provider call, no client secret; the sweep/operator recovery path owns
  // this case.
  if (
    existing &&
    existing.providerPaymentId === null &&
    Date.now() - existing.createdAt.getTime() >= IDEMPOTENT_RECOVERY_MAX_AGE_MS
  ) {
    throw new ConflictError(
      "A previous payment attempt for this order is still being reviewed. Please contact support.",
      `Order ${order.orderNumber}: unresolved payment claim older than the idempotency recovery window`,
    );
  }

  // Nothing resolved yet — either genuinely nothing (`existing` is absent),
  // or an UNRESOLVED claim is already sitting there (`existing` exists with
  // `providerPaymentId: null`), left behind by an interrupted earlier
  // attempt (this request's own retry, another tab, or a process that
  // crashed between the provider call succeeding and this row being
  // updated). Both cases are handled identically from here: establish (or
  // confirm) the claim, then resolve it via the provider.
  //
  // DURABLE COORDINATION, not a timing-based check: this transaction
  // acquires the exact same `SELECT ... FOR UPDATE` lock on the `Order` row
  // (`lockOrderRow`, `order-inventory.ts`) that
  // `applyOrderStatusTransitionTx` acquires before cancelling one — the
  // abandoned-checkout expiry sweep's cancellation and this claim can
  // therefore never both proceed as if each had won; PostgreSQL serializes
  // them, and whichever commits first is authoritative for the other. If
  // the order is no longer PENDING/UNPAID by the time this transaction
  // actually acquires the lock (the sweep, or an admin, won first), this
  // throws BEFORE any provider call is ever made — "if expiry wins first,
  // payment creation must not start." Once this transaction's claim DOES
  // commit, the inverse is also guaranteed: `applyOrderStatusTransitionTx`
  // itself refuses to cancel (release) an order with an unresolved claim
  // (`providerPaymentId: null`) until it is reconciled — not merely
  // "unlikely to race," structurally unable to, for as long as the claim
  // exists unresolved.
  const claim = await db.$transaction(async (tx) => {
    const locked = await lockOrderRow(tx, order.id);
    if (!locked || locked.status !== OrderStatus.PENDING || locked.paymentStatus !== PaymentStatus.UNPAID) {
      return "order_not_payable" as const;
    }
    if (!existing) {
      try {
        await tx.payment.create({
          data: {
            orderId: order.id,
            provider: PAYMENT_PROVIDER,
            providerPaymentId: null,
            status: PaymentTransactionStatus.PENDING,
            amountCents: order.totalCents,
            currency: order.currency,
          },
        });
        return "inserted" as const;
      } catch (error) {
        // Lost a race to another concurrent `startPayment` call claiming
        // the same order — fine, its claim (resolved or not) is exactly
        // what the provider call below reconciles against.
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
          throw error;
        }
      }
    }
    return "already_claimed" as const;
  }, TX_OPTIONS);

  if (claim === "order_not_payable") {
    throw new CatalogValidationError("This order can no longer be paid.");
  }

  await hooks.afterClaimCommitted?.();

  // Provider I/O happens OUTSIDE any transaction, using a stable, per-order
  // idempotency key. This call is safe whether it's a brand-new claim or
  // recovering an interrupted one: per Stripe's own documentation
  // (docs.stripe.com/api/idempotent_requests), a retried request with the
  // same key and the same parameters returns the ORIGINAL object if this
  // exact request already reached Stripe, or creates a genuinely new one
  // if it never did — never a duplicate charge either way. A concurrent
  // in-flight request using the SAME key is Stripe's own documented `409
  // Conflict` case (docs.stripe.com/error-low-level#idempotency: "the
  // request conflicts with another request... perhaps due to using the
  // same idempotent key... You can retry these requests") — `stripe.ts`'s
  // `wrap()` classifies this specifically as `ambiguous: true`, so it is
  // retried like any other transient failure, never treated as a
  // definitive decline.
  const pi = await createOrRecoverPaymentIntent(gateway, {
    orderId: order.id,
    orderNumber: order.orderNumber,
    amountCents: order.totalCents,
    currency,
    receiptEmail: order.customerEmail,
  });

  // Persist the resolved id. If the PROCESS crashes before this line, the
  // claim row is left exactly as it was — `providerPaymentId: null` — a
  // well-defined "interrupted creation" state, not an absence of any
  // record. `src/server/orders/order-expiry.ts`'s sweep recognizes this
  // exact state and recovers it the same way: retrying
  // `createPaymentIntent` with this SAME idempotency key, reusing this
  // documented recovery path rather than a second implementation of it.
  //
  // Guarded on `providerPaymentId: null` so this can never overwrite an id a
  // concurrent recovery (the sweep, another tab) already resolved the claim
  // to. Within the recovery window both necessarily reference the same
  // PaymentIntent (same key, same parameters); if the row nonetheless
  // points somewhere else, fail closed rather than hand out a client secret
  // the local record doesn't back.
  const persisted = await db.payment.updateMany({
    where: { orderId: order.id, providerPaymentId: null },
    data: { providerPaymentId: pi.id },
  });
  if (persisted.count === 0) {
    const current = await db.payment.findUnique({
      where: { orderId: order.id },
      select: { providerPaymentId: true },
    });
    if (current?.providerPaymentId !== pi.id) {
      throw new ConflictError(
        "This order's payment record changed while it was being set up. Please try again.",
        `Order ${order.orderNumber}: payment record points at ${current?.providerPaymentId ?? "nothing"}, provider returned ${pi.id}`,
      );
    }
  }

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PAYMENT_INTENT_CREATED,
      actorUserId: order.userId,
      entityType: "Order",
      entityId: order.id,
      metadata: {
        orderNumber: order.orderNumber,
        amountCents: order.totalCents,
        currency: order.currency,
        paymentIntentId: pi.id,
      },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
    db,
  );

  // A replayed idempotent response is the ORIGINAL response body, not the
  // object's current state (docs.stripe.com/api/idempotent_requests: Stripe
  // "sav[es] the resulting status code and body of the first request" and
  // returns it for later requests with the same key). So when this call may
  // be a replay — anything other than the call that inserted the claim —
  // its `status`/`clientSecret` can describe a PaymentIntent that has since
  // succeeded or been cancelled. Ask for the current truth before deciding
  // what to hand the customer.
  if (claim === "inserted") {
    // This very call inserted the claim and the provider just created the
    // intent for the first time: its response IS the current state (a brand
    // new intent is payable by construction), exactly as before the claim
    // mechanism existed.
    if (!pi.clientSecret) throw new CatalogValidationError("Could not initialise payment.");
    return {
      orderNumber,
      amountCents: order.totalCents,
      currency,
      clientSecret: pi.clientSecret,
      publishableKey,
      orderStatus: order.status,
      paymentStatus: order.paymentStatus,
      alreadyPaid: false,
    };
  }
  const authoritative = await gateway.retrievePaymentIntent(pi.id);
  return finishStartPayment(authoritative, order, orderNumber, currency, publishableKey, db, gateway);
}

/**
 * Turn an authoritative `PaymentIntentView` into the `StartPaymentResult`
 * the caller sees — shared by both the "already resolved" branch and the
 * "just resolved via a fresh or recovered claim" branch of `startPayment`,
 * so the succeeded/payable/otherwise decision is made in exactly one place.
 */
async function finishStartPayment(
  pi: PaymentIntentView,
  order: { id: string; totalCents: number },
  orderNumber: string,
  currency: string,
  publishableKey: string,
  db: Db,
  gateway: PaymentGateway,
): Promise<StartPaymentResult> {
  if (pi.status === "succeeded") {
    await finalizeFromPaymentIntent(pi, "return", db, gateway);
    return {
      orderNumber,
      amountCents: order.totalCents,
      currency,
      clientSecret: "",
      publishableKey,
      orderStatus: OrderStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      alreadyPaid: true,
    };
  }
  if (PAYABLE_PI_STATUSES.has(pi.status) && pi.clientSecret) {
    return {
      orderNumber,
      amountCents: order.totalCents,
      currency,
      clientSecret: pi.clientSecret,
      publishableKey,
      orderStatus: OrderStatus.PENDING,
      paymentStatus: PaymentStatus.UNPAID,
      alreadyPaid: false,
    };
  }
  throw new CatalogValidationError("This order can no longer be paid.");
}

// ---------------------------------------------------------------------------
// Idempotent completion — the ONE authoritative path
// ---------------------------------------------------------------------------

export type FinalizeOutcome =
  | "paid"
  | "already_paid"
  | "failed"
  | "already_failed"
  | "late_success"
  | "amount_mismatch"
  | "pending"
  | "order_missing";

export interface FinalizeResult {
  outcome: FinalizeOutcome;
  orderNumber: string | null;
  orderStatus: OrderStatus | null;
  paymentStatus: PaymentStatus | null;
}

interface AuditPlan {
  action: string;
  entityId?: string;
  metadata: Record<string, unknown>;
}

async function loadOrderForPayment(tx: Tx, pi: PaymentIntentView) {
  const orderId = pi.metadata.orderId;
  const order = orderId
    ? await tx.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          paymentStatus: true,
          totalCents: true,
          currency: true,
          userId: true,
        },
      })
    : null;
  return order;
}

/** Body of `finalizeFromPaymentIntent`, composable inside a caller's transaction. */
export async function finalizeFromPaymentIntentTx(
  tx: Tx,
  pi: PaymentIntentView,
  source: "webhook" | "return" | "expiry",
): Promise<{ result: FinalizeResult; audit: AuditPlan | null }> {
  const order = await loadOrderForPayment(tx, pi);
  if (!order) {
    return {
      result: {
        outcome: "order_missing",
        orderNumber: null,
        orderStatus: null,
        paymentStatus: null,
      },
      audit: {
        action: AUDIT_ACTIONS.PAYMENT_WEBHOOK_STALE,
        metadata: { paymentIntentId: pi.id, reason: "no order for metadata.orderId", source },
      },
    };
  }

  const done = (outcome: FinalizeOutcome, audit: Omit<AuditPlan, "entityId"> | null = null) => ({
    result: {
      outcome,
      orderNumber: order.orderNumber,
      orderStatus: order.status,
      paymentStatus: order.paymentStatus,
    },
    audit: audit ? { ...audit, entityId: order.id } : null,
  });

  // --- amount / currency verification (never trust anything but the frozen order)
  const currencyMatches = pi.currency.toUpperCase() === order.currency;
  const amountMatches = pi.amount === order.totalCents;
  if (!amountMatches || !currencyMatches) {
    await tx.payment.updateMany({
      where: { orderId: order.id },
      data: {
        status: PaymentTransactionStatus.FAILED,
        errorMessage: `Amount/currency mismatch: intent ${pi.amount} ${pi.currency}, order ${order.totalCents} ${order.currency}`,
      },
    });
    return done("amount_mismatch", {
      action: AUDIT_ACTIONS.PAYMENT_AMOUNT_MISMATCH,
      metadata: {
        orderNumber: order.orderNumber,
        paymentIntentId: pi.id,
        intentAmount: pi.amount,
        intentCurrency: pi.currency,
        orderTotal: order.totalCents,
        orderCurrency: order.currency,
        source,
      },
    });
  }

  if (pi.status === "succeeded") {
    if (order.paymentStatus === PaymentStatus.PAID) return done("already_paid");

    if (order.status !== OrderStatus.PENDING) {
      // Payment captured but the order is already terminal (e.g. cancelled after
      // an earlier failure event). Money is held; a Phase 8 refund is required.
      await tx.payment.updateMany({
        where: { orderId: order.id },
        data: {
          status: PaymentTransactionStatus.CAPTURED,
          errorMessage: "Captured after the order left PENDING — refund required.",
          metadata: piCardMetadata(pi),
        },
      });
      return done("late_success", {
        action: AUDIT_ACTIONS.PAYMENT_LATE_SUCCESS,
        metadata: {
          orderNumber: order.orderNumber,
          orderStatus: order.status,
          paymentIntentId: pi.id,
          source,
        },
      });
    }

    await tx.payment.updateMany({
      where: { orderId: order.id },
      data: {
        status: PaymentTransactionStatus.CAPTURED,
        errorMessage: null,
        metadata: piCardMetadata(pi),
      },
    });
    await tx.order.update({
      where: { id: order.id },
      data: { paymentStatus: PaymentStatus.PAID },
    });
    // Commit the Phase 5 reservation. The per-line idempotency keys guarantee
    // the stock is committed exactly once even under a webhook redelivery race.
    await applyOrderStatusTransitionTx(tx, order.id, OrderStatus.CONFIRMED);
    // Same transaction as the state change above (Phase 8) — the job and the
    // payment success commit together, or neither does. Idempotent: a
    // webhook redelivery race that reaches here twice never queues twice
    // (see `enqueueOrderEmailTx`).
    await enqueueOrderEmailTx(tx, order.id, OrderEmailType.ORDER_CONFIRMATION);

    return done("paid", {
      action: AUDIT_ACTIONS.PAYMENT_SUCCEEDED,
      metadata: {
        orderNumber: order.orderNumber,
        amountCents: order.totalCents,
        currency: order.currency,
        paymentIntentId: pi.id,
        card: piCardMetadata(pi),
        source,
      },
    });
  }

  if (pi.status === "canceled") {
    return finalizeFailureTx(tx, pi, source, pi.lastError ?? "PaymentIntent canceled");
  }

  return done("pending");
}

/** Failure / cancellation path: FAILED payment, order CANCELLED, stock released. */
export async function finalizeFailureTx(
  tx: Tx,
  pi: PaymentIntentView,
  source: "webhook" | "return" | "expiry",
  reason: string,
): Promise<{ result: FinalizeResult; audit: AuditPlan | null }> {
  const order = await loadOrderForPayment(tx, pi);
  if (!order) {
    return {
      result: {
        outcome: "order_missing",
        orderNumber: null,
        orderStatus: null,
        paymentStatus: null,
      },
      audit: {
        action: AUDIT_ACTIONS.PAYMENT_WEBHOOK_STALE,
        metadata: { paymentIntentId: pi.id, reason: "no order for failed intent", source },
      },
    };
  }

  const done = (outcome: FinalizeOutcome, audit: Omit<AuditPlan, "entityId"> | null = null) => ({
    result: {
      outcome,
      orderNumber: order.orderNumber,
      orderStatus: order.status,
      paymentStatus: order.paymentStatus,
    },
    audit: audit ? { ...audit, entityId: order.id } : null,
  });

  if (order.paymentStatus === PaymentStatus.PAID || order.status !== OrderStatus.PENDING) {
    // Out of order (a success already won, or the order is already terminal).
    return done("already_failed", {
      action: AUDIT_ACTIONS.PAYMENT_WEBHOOK_STALE,
      metadata: {
        orderNumber: order.orderNumber,
        orderStatus: order.status,
        paymentStatus: order.paymentStatus,
        paymentIntentId: pi.id,
        reason,
        source,
      },
    });
  }

  await tx.payment.updateMany({
    where: { orderId: order.id },
    data: { status: PaymentTransactionStatus.FAILED, errorMessage: reason.slice(0, 500) },
  });
  await tx.order.update({
    where: { id: order.id },
    data: { paymentStatus: PaymentStatus.FAILED },
  });
  // Release the Phase 5 reservation.
  await applyOrderStatusTransitionTx(tx, order.id, OrderStatus.CANCELLED);

  return done("failed", {
    action: AUDIT_ACTIONS.PAYMENT_FAILED,
    metadata: {
      orderNumber: order.orderNumber,
      paymentIntentId: pi.id,
      reason,
      source,
    },
  });
}

function piCardMetadata(pi: PaymentIntentView): Prisma.InputJsonValue {
  return { brand: pi.card?.brand ?? "", last4: pi.card?.last4 ?? "" };
}

/** Open a transaction, finalize, then record the audit row (post-commit). */
export async function finalizeFromPaymentIntent(
  pi: PaymentIntentView,
  source: "webhook" | "return" | "expiry",
  db: Db = prisma,
  _gateway: PaymentGateway = getPaymentGateway(),
): Promise<FinalizeResult> {
  const { result, audit } = await db.$transaction(
    (tx) => finalizeFromPaymentIntentTx(tx, pi, source),
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
      db,
    );
  }
  // Post-commit, best-effort (Phase 8) — never throws, never blocks the
  // caller on a transport; see `kickEmailDispatch`'s own doc comment.
  if (result.outcome === "paid") {
    await kickEmailDispatch(db);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Return-page verification (server-side, never trusts the browser redirect)
// ---------------------------------------------------------------------------

export interface PaymentStatusView {
  orderNumber: string;
  orderStatus: OrderStatus;
  paymentStatus: PaymentStatus;
  outcome: FinalizeOutcome | "unknown";
}

export async function verifyPaymentStatus(
  orderNumber: string,
  ctx: StartPaymentContext,
  db: Db = prisma,
  gateway: PaymentGateway = getPaymentGateway(),
): Promise<PaymentStatusView> {
  const order = await db.order.findUnique({
    where: { orderNumber },
    select: {
      id: true,
      orderNumber: true,
      userId: true,
      status: true,
      paymentStatus: true,
    },
  });
  if (!order) throw new NotFoundError("Order", orderNumber);
  assertViewable(order, ctx);

  const payment = await db.payment.findUnique({
    where: { orderId: order.id },
    select: { providerPaymentId: true },
  });

  let outcome: FinalizeOutcome | "unknown" = "unknown";
  if (
    payment?.providerPaymentId &&
    order.paymentStatus === PaymentStatus.UNPAID &&
    order.status === OrderStatus.PENDING
  ) {
    // Ask Stripe directly (authoritative) and run the same idempotent finalize.
    const pi = await gateway.retrievePaymentIntent(payment.providerPaymentId);
    outcome = (await finalizeFromPaymentIntent(pi, "return", db, gateway)).outcome;
  }

  const fresh = await db.order.findUniqueOrThrow({
    where: { id: order.id },
    select: { orderNumber: true, status: true, paymentStatus: true },
  });
  return {
    orderNumber: fresh.orderNumber,
    orderStatus: fresh.status,
    paymentStatus: fresh.paymentStatus,
    outcome,
  };
}
