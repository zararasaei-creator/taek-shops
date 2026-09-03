import {
  OrderStatus,
  PaymentStatus,
  PaymentTransactionStatus,
  Prisma,
  type PrismaClient,
} from "@prisma/client";

import { prisma } from "@/server/db/client";
import { clientEnv } from "@/server/config/env";
import { recordAudit } from "@/server/audit/audit-service";
import { AUDIT_ACTIONS } from "@/server/audit/actions";
import { CatalogValidationError, NotFoundError } from "@/server/catalog/errors";
import { hasPermission, type AuthUser } from "@/server/auth/authorization";
import { applyOrderStatusTransitionTx } from "@/server/orders/order-inventory";
import { PAYMENT_PROVIDER } from "@/server/payments/config";
import { getPaymentGateway } from "@/server/domain/payments";
import type { PaymentGateway, PaymentIntentView } from "@/server/domain/payments";

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

export async function startPayment(
  orderNumber: string,
  ctx: StartPaymentContext,
  meta: Meta = {},
  db: Db = prisma,
  gateway: PaymentGateway = getPaymentGateway(),
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

  // Reuse a live PaymentIntent if one already exists for this order.
  if (existing?.providerPaymentId) {
    const pi = await gateway.retrievePaymentIntent(existing.providerPaymentId);
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
        orderStatus: order.status,
        paymentStatus: order.paymentStatus,
        alreadyPaid: false,
      };
    }
    throw new CatalogValidationError("This order can no longer be paid.");
  }

  // Create a fresh PaymentIntent. The Stripe idempotency key is per-order, so a
  // retry (or a race between two tabs) returns the SAME intent — never a second
  // charge. The DB `@@unique([orderId])` blocks a second Payment row.
  const pi = await gateway.createPaymentIntent({
    amountCents: order.totalCents,
    currency,
    metadata: { orderId: order.id, orderNumber: order.orderNumber },
    idempotencyKey: `pi-create-${order.id}`,
    description: `Taek Shops order ${order.orderNumber}`,
    receiptEmail: order.customerEmail,
  });

  try {
    await db.payment.create({
      data: {
        orderId: order.id,
        provider: PAYMENT_PROVIDER,
        providerPaymentId: pi.id,
        status: PaymentTransactionStatus.PENDING,
        amountCents: order.totalCents,
        currency: order.currency,
      },
    });
  } catch (error) {
    // Lost a race — another request already created the row for this order.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
      throw error;
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
  source: "webhook" | "return",
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
  source: "webhook" | "return",
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
  source: "webhook" | "return",
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
