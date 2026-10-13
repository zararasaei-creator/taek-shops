import { OrderStatus, PaymentStatus, type PrismaClient } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { requirePermission, type AuthUser } from "@/server/auth/authorization";
import { recordAudit } from "@/server/audit/audit-service";
import { AUDIT_ACTIONS } from "@/server/audit/actions";
import { ConflictError, NotFoundError } from "@/server/catalog/errors";
import { getPaymentGateway, PaymentGatewayError } from "@/server/domain/payments";
import type { PaymentGateway } from "@/server/domain/payments";
import { applyOrderStatusTransition, type OrderTransitionResult } from "@/server/orders/order-inventory";
import {
  backfillOrphanedPayment,
  reconcileLinkedPayment,
  type ExpiryOutcome,
} from "@/server/orders/order-expiry";
import { claimEra, claimsActiveSince, type ClaimEra } from "@/server/orders/payment-service";

/**
 * Admin cancellation of a `PENDING`/`UNPAID` order — provider-aware.
 *
 * **Invariant (same one the expiry sweep and `startPayment` obey):** stock is
 * never released while a payment against the order could still be payable or
 * succeed. A `late_success` + refund is NOT an acceptable substitute — it
 * means the customer was charged against released stock — so this never
 * relies on one.
 *
 * Before this module the admin "Cancel order" button released stock for a
 * pending order directly, leaving any linked, still-payable PaymentIntent
 * alive at the provider. Now:
 *
 * - **Linked PaymentIntent**: ask the provider for current truth, then run
 *   the SAME `reconcileLinkedPayment` the sweep uses. Stock is released only
 *   through `finalizeFromPaymentIntent` → `applyOrderStatusTransitionTx`,
 *   i.e. only after the provider CONFIRMS cancellation (or already reports it
 *   canceled). `succeeded` ⇒ the order is reconciled as PAID and NOT
 *   cancelled; `processing` or an ambiguous (network/timeout/409) outcome ⇒
 *   nothing changes. Each of those is reported to the admin as an explicit
 *   `ConflictError` message — the order is never silently left half-cancelled.
 * - **Unresolved claim** (`providerPaymentId: null`): refused by the shared
 *   lock + `applyOrderStatusTransitionTx` guard until reconciled.
 * - **No `Payment` row**: a provider search runs first (hit ⇒ reconcile as
 *   above). A miss releases stock ONLY for a `post_claim` order (see
 *   `claimEra`). For a legacy order, or when `PAYMENT_CLAIMS_ACTIVE_SINCE` is
 *   not configured, it is refused (`LegacyPaymentUnresolvedError`) and the
 *   order stays reserved for manual reconciliation. **There is deliberately no
 *   operator override**: neither a checkbox nor a search miss is proof that no
 *   payment can still succeed, so no in-app action bypasses the payment/claim
 *   guards for such an order.
 *
 * Provider I/O never happens inside a DB transaction; the final release goes
 * through the shared Order-row lock, which independently re-refuses if a
 * payment attempt appeared in the meantime.
 */

type Db = PrismaClient;
type Actor = AuthUser | null | undefined;

/**
 * An order whose payment history cannot be established (legacy, or the rollout
 * boundary is unconfigured) with no provider evidence either way. Stock stays
 * reserved; resolution is manual (roadmap runbook), by evidence only.
 */
export class LegacyPaymentUnresolvedError extends ConflictError {
  constructor(orderNumber: string, orderId: string, era: ClaimEra) {
    super(
      era === "unknown"
        ? `Order ${orderNumber} was NOT cancelled and its stock stays reserved: PAYMENT_CLAIMS_ACTIVE_SINCE is not configured, so it cannot be established that no payment was ever attempted. Configuration and manual reconciliation are required.`
        : `Order ${orderNumber} was NOT cancelled and its stock stays reserved: it predates durable payment tracking and no PaymentIntent was found by search, which is not proof that none exists. Manual reconciliation is required — search the Stripe Dashboard for metadata orderId = ${orderId}.`,
    );
  }
}

export interface CancelPendingOptions {
  db?: Db;
  gateway?: PaymentGateway;
  /** Test seam; `undefined` defaults to `PAYMENT_CLAIMS_ACTIVE_SINCE`, `null` means unconfigured. */
  claimsActiveSince?: Date | null;
}

async function preserved(
  db: Db,
  actor: NonNullable<Actor>,
  order: { id: string; orderNumber: string },
  reason: string,
  message: string,
): Promise<never> {
  await recordAudit(
    {
      action: AUDIT_ACTIONS.ORDER_CANCEL_PRESERVED,
      actorUserId: actor.id,
      entityType: "Order",
      entityId: order.id,
      metadata: { orderNumber: order.orderNumber, reason },
    },
    db,
  );
  throw new ConflictError(message);
}

export async function cancelPendingOrder(
  actor: Actor,
  orderId: string,
  options: CancelPendingOptions = {},
): Promise<OrderTransitionResult> {
  const authed = requirePermission(actor, "order.write");
  const db = options.db ?? prisma;
  const gateway = options.gateway ?? getPaymentGateway();
  const since = options.claimsActiveSince !== undefined ? options.claimsActiveSince : claimsActiveSince();

  const order = await db.order.findUnique({
    where: { id: orderId },
    select: { id: true, orderNumber: true, status: true, paymentStatus: true, createdAt: true },
  });
  if (!order) throw new NotFoundError("Order", orderId);

  // Anything other than a pending, unpaid order has no live payment to
  // reconcile (a paid order's cancel is the restock path) — the shared
  // transition (with its own guards) is the whole story.
  if (order.status !== OrderStatus.PENDING || order.paymentStatus !== PaymentStatus.UNPAID) {
    return applyOrderStatusTransition(actor, orderId, OrderStatus.CANCELLED, db);
  }

  const cancelledResult = (): OrderTransitionResult => ({
    orderId: order.id,
    from: OrderStatus.PENDING,
    to: OrderStatus.CANCELLED,
    inventoryEffect: "release",
  });

  const payment = await db.payment.findUnique({
    where: { orderId },
    select: { providerPaymentId: true },
  });

  // ---- A claim whose provider outcome is unknown: the shared guard decides
  // (under the Order lock) and throws a clear ConflictError.
  if (payment && payment.providerPaymentId === null) {
    return applyOrderStatusTransition(actor, orderId, OrderStatus.CANCELLED, db);
  }

  let outcome: ExpiryOutcome;
  try {
    if (payment?.providerPaymentId) {
      const pi = await gateway.retrievePaymentIntent(payment.providerPaymentId);
      outcome = await reconcileLinkedPayment(db, gateway, order.id, pi);
    } else {
      // No local Payment row. Provider search first — a hit is real evidence.
      const found = await gateway.findPaymentIntentForOrder(order.id);
      if (found) {
        // Search can carry a stale cached status: re-retrieve before deciding.
        const fresh = await gateway.retrievePaymentIntent(found.id);
        await backfillOrphanedPayment(db, order.id, fresh);
        outcome = await reconcileLinkedPayment(db, gateway, order.id, fresh);
      } else if (claimEra(order.createdAt, since) !== "post_claim") {
        const era = claimEra(order.createdAt, since);
        return preserved(
          db,
          authed,
          order,
          era === "unknown" ? "claims_cutoff_unconfigured" : "legacy_needs_reconciliation",
          new LegacyPaymentUnresolvedError(order.orderNumber, order.id, era).publicMessage,
        );
      } else {
        // Post-claim order with no row: provably never attempted. The shared
        // lock + guard re-check this under serialization.
        return applyOrderStatusTransition(actor, orderId, OrderStatus.CANCELLED, db);
      }
    }
  } catch (error) {
    if (error instanceof PaymentGatewayError && error.ambiguous) {
      return preserved(
        db,
        authed,
        order,
        "provider_uncertain",
        `Could not confirm the payment's state with the provider (network or timeout). Order ${order.orderNumber} was NOT cancelled and its stock reservation is unchanged. Try again shortly.`,
      );
    }
    throw error;
  }

  switch (outcome) {
    case "cancelled_provider_confirmed":
      await recordAudit(
        {
          action: AUDIT_ACTIONS.ORDER_STATUS_CHANGED,
          actorUserId: authed.id,
          entityType: "Order",
          entityId: order.id,
          metadata: {
            orderNumber: order.orderNumber,
            from: OrderStatus.PENDING,
            to: OrderStatus.CANCELLED,
            inventoryEffect: "release",
            via: "provider_confirmed_cancellation",
          },
        },
        db,
      );
      return cancelledResult();

    case "finalized_paid":
      return preserved(
        db,
        authed,
        order,
        "payment_succeeded",
        `Order ${order.orderNumber} was NOT cancelled: the customer's payment had already succeeded, so it is now confirmed and paid. To reverse it, issue a refund.`,
      );

    case "preserved_processing":
      return preserved(
        db,
        authed,
        order,
        "payment_processing",
        `Order ${order.orderNumber} was NOT cancelled: its payment is processing at the provider. The order and stock reservation are unchanged — try again once it settles.`,
      );

    case "preserved_ambiguous":
      return preserved(
        db,
        authed,
        order,
        "provider_uncertain",
        `The provider did not confirm cancellation of order ${order.orderNumber}'s payment (network or timeout). It was NOT cancelled and its stock reservation is unchanged. Try again shortly.`,
      );

    default: {
      // already_resolved (webhook / sweep / another admin won): report the truth.
      const now = await db.order.findUniqueOrThrow({
        where: { id: order.id },
        select: { status: true, paymentStatus: true },
      });
      if (now.status === OrderStatus.CANCELLED) return cancelledResult();
      return preserved(
        db,
        authed,
        order,
        `unexpected_${outcome}`,
        `Order ${order.orderNumber} was NOT cancelled: its payment state changed while cancelling (now ${now.status} / ${now.paymentStatus}). Review the order and retry if appropriate.`,
      );
    }
  }
}
