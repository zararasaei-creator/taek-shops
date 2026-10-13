import { randomUUID } from "node:crypto";

import {
  OrderStatus,
  PaymentStatus,
  PaymentTransactionStatus,
  RefundStatus,
  StockMovementType,
  UserRole,
} from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ForbiddenError, UnauthenticatedError } from "@/server/auth/errors";
import { CatalogValidationError } from "@/server/catalog/errors";
import { PaymentGatewayError, __setPaymentGateway } from "@/server/domain/payments";
import { reconcileRefund, requestRefund } from "@/server/orders/refund-service";
import { POST as stripeWebhook } from "@/app/api/webhooks/stripe/route";
import { db } from "./helpers/db";
import { FakeStripeGateway, makeRefundEvent } from "./helpers/payments";

/**
 * Phase 8 refunds, against a real, isolated database (never mocked) — the
 * real `refund-service.ts`, real Prisma, real `AuditLog` rows, and (for the
 * webhook-reconciliation cases) the real webhook route. A controlled
 * `FakeStripeGateway` stands in for Stripe — this proves the application's
 * own logic, not real Stripe refund behaviour (see the roadmap for what
 * remains provider-unverified).
 *
 * Namespaced separately from every other suite:
 *   - products : slug starts `zzz-phase8r-`
 *   - variants : sku   starts `PF8R-`
 *   - orders   : orderNumber starts `PF8R-ORD-`
 *   - actors   : `phase8r-{customer,staff,manager}@taek.local`
 */

const PRODUCT_SLUG_PREFIX = "zzz-phase8r-";
const SKU_PREFIX = "PF8R-";
const ORDER_PREFIX = "PF8R-ORD-";

let rand = 0;
function uid(): string {
  rand += 1;
  return `${Date.now().toString(36)}${rand}`;
}
function key(): string {
  return `refund_${randomUUID()}`;
}

interface Actor {
  id: string;
  role: UserRole;
}

async function ensureActor(role: UserRole): Promise<Actor> {
  const email = `phase8r-${role.toLowerCase()}@taek.local`;
  return db.user.upsert({
    where: { email },
    update: { role, status: "ACTIVE" },
    create: { email, role, status: "ACTIVE", firstName: "Phase8R", lastName: role },
    select: { id: true, role: true },
  });
}

async function makeVariant(
  onHand = 5,
): Promise<{ variantId: string; inventoryItemId: string; sku: string }> {
  const suffix = uid();
  const sku = `${SKU_PREFIX}${suffix}`;
  const product = await db.product.create({
    data: {
      name: `Phase 8 Refund Test ${suffix}`,
      slug: `${PRODUCT_SLUG_PREFIX}${suffix}`,
      status: "ACTIVE",
      active: true,
      variants: {
        create: {
          sku,
          priceCents: 5000,
          optionSignature: "",
          inventoryItem: { create: { quantityOnHand: onHand, quantityReserved: 0 } },
        },
      },
    },
    select: { variants: { select: { id: true, inventoryItem: { select: { id: true } } } } },
  });
  const variant = product.variants[0]!;
  return { variantId: variant.id, inventoryItemId: variant.inventoryItem!.id, sku };
}

/** A CONFIRMED/PAID order with one captured Payment row, ready to refund. */
async function makePaidOrder(opts: {
  amountCents?: number;
  refundedCents?: number;
  paymentStatus?: PaymentTransactionStatus;
  variant?: { variantId: string; sku: string };
}): Promise<{ orderId: string; paymentId: string; providerPaymentId: string }> {
  const amountCents = opts.amountCents ?? 5000;
  const providerPaymentId = `pi_test_${uid()}`;
  const order = await db.order.create({
    data: {
      orderNumber: `${ORDER_PREFIX}${uid()}`,
      customerEmail: "phase8r-order@taek.local",
      status: OrderStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      totalCents: amountCents,
      ...(opts.variant
        ? {
            items: {
              create: {
                variantId: opts.variant.variantId,
                sku: opts.variant.sku,
                productName: "Phase 8 Refund Test",
                unitPriceCents: amountCents,
                quantity: 1,
                lineSubtotalCents: amountCents,
                lineTotalCents: amountCents,
              },
            },
          }
        : {}),
      payments: {
        create: {
          provider: "stripe",
          providerPaymentId,
          status: opts.paymentStatus ?? PaymentTransactionStatus.CAPTURED,
          amountCents,
          refundedCents: opts.refundedCents ?? 0,
        },
      },
    },
    select: { id: true, payments: { select: { id: true } } },
  });
  return { orderId: order.id, paymentId: order.payments[0]!.id, providerPaymentId };
}

async function cleanup(): Promise<void> {
  const actorEmails = [UserRole.CUSTOMER, UserRole.STAFF, UserRole.MANAGER].map(
    (r) => `phase8r-${r.toLowerCase()}@taek.local`,
  );
  const actors = await db.user.findMany({ where: { email: { in: actorEmails } }, select: { id: true } });
  if (actors.length > 0) {
    await db.auditLog.deleteMany({ where: { actorUserId: { in: actors.map((a) => a.id) } } });
  }
  await db.auditLog.deleteMany({ where: { entityType: "Order", entityId: { in: await orderIds() } } });
  await db.order.deleteMany({ where: { orderNumber: { startsWith: ORDER_PREFIX } } });
  await db.product.deleteMany({ where: { slug: { startsWith: PRODUCT_SLUG_PREFIX } } });
  await db.user.deleteMany({ where: { email: { in: actorEmails } } });
}
async function orderIds(): Promise<string[]> {
  const orders = await db.order.findMany({
    where: { orderNumber: { startsWith: ORDER_PREFIX } },
    select: { id: true },
  });
  return orders.map((o) => o.id);
}

let customer: Actor;
let staff: Actor;
let manager: Actor;

beforeAll(async () => {
  await cleanup();
  [customer, staff, manager] = await Promise.all([
    ensureActor(UserRole.CUSTOMER),
    ensureActor(UserRole.STAFF),
    ensureActor(UserRole.MANAGER),
  ]);
});

afterEach(() => {
  __setPaymentGateway(null);
});

afterAll(async () => {
  await cleanup();
  await db.$disconnect();
});

describe("authorization: MANAGER/ADMIN only, STAFF and customers denied", () => {
  it("requestRefund denies unauthenticated, CUSTOMER, and STAFF; allows MANAGER", async () => {
    const gateway = new FakeStripeGateway();
    const { orderId } = await makePaidOrder({});
    const input = { amountCents: 1000, reason: "test", idempotencyKey: key() };

    await expect(requestRefund(null, orderId, input, {}, db, gateway)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    await expect(requestRefund(customer, orderId, input, {}, db, gateway)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(requestRefund(staff, orderId, input, {}, db, gateway)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      requestRefund(manager, orderId, { ...input, idempotencyKey: key() }, {}, db, gateway),
    ).resolves.toBeDefined();
  });
});

describe("full and partial refunds", () => {
  it("a full refund marks the Payment and Order REFUNDED", async () => {
    const gateway = new FakeStripeGateway();
    const { orderId, paymentId } = await makePaidOrder({ amountCents: 5000 });

    const refund = await requestRefund(
      manager,
      orderId,
      { amountCents: 5000, reason: "full refund", idempotencyKey: key() },
      {},
      db,
      gateway,
    );
    expect(refund.status).toBe(RefundStatus.SUCCEEDED);

    const payment = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe(PaymentTransactionStatus.REFUNDED);
    expect(payment.refundedCents).toBe(5000);
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.paymentStatus).toBe(PaymentStatus.REFUNDED);
    // Refunding never touches OrderStatus.
    expect(order.status).toBe(OrderStatus.CONFIRMED);

    const audit = await db.auditLog.findFirst({
      where: { entityType: "Order", entityId: orderId, action: "payment.refund.succeeded" },
    });
    expect(audit).not.toBeNull();
  });

  it("two partial refunds accumulate to PARTIALLY_REFUNDED then REFUNDED", async () => {
    const gateway = new FakeStripeGateway();
    const { orderId, paymentId } = await makePaidOrder({ amountCents: 5000 });

    await requestRefund(
      manager,
      orderId,
      { amountCents: 2000, reason: "partial 1", idempotencyKey: key() },
      {},
      db,
      gateway,
    );
    let payment = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe(PaymentTransactionStatus.PARTIALLY_REFUNDED);
    expect(payment.refundedCents).toBe(2000);
    let order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.paymentStatus).toBe(PaymentStatus.PARTIALLY_REFUNDED);

    await requestRefund(
      manager,
      orderId,
      { amountCents: 3000, reason: "partial 2 completes it", idempotencyKey: key() },
      {},
      db,
      gateway,
    );
    payment = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe(PaymentTransactionStatus.REFUNDED);
    expect(payment.refundedCents).toBe(5000);
    order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.paymentStatus).toBe(PaymentStatus.REFUNDED);
  });
});

describe("over-refund rejection", () => {
  it("rejects an amount exceeding the refundable balance and leaves everything untouched", async () => {
    const gateway = new FakeStripeGateway();
    const { orderId, paymentId } = await makePaidOrder({ amountCents: 5000, refundedCents: 3000 });

    await expect(
      requestRefund(
        manager,
        orderId,
        { amountCents: 2001, reason: "too much", idempotencyKey: key() },
        {},
        db,
        gateway,
      ),
    ).rejects.toBeInstanceOf(CatalogValidationError);

    const payment = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.refundedCents).toBe(3000); // unchanged
    expect(await db.refund.count({ where: { paymentId } })).toBe(0); // no row created
  });

  it("exactly the remaining balance is accepted", async () => {
    const gateway = new FakeStripeGateway();
    const { orderId, paymentId } = await makePaidOrder({ amountCents: 5000, refundedCents: 3000 });

    await requestRefund(
      manager,
      orderId,
      { amountCents: 2000, reason: "exact remainder", idempotencyKey: key() },
      {},
      db,
      gateway,
    );
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe(
      PaymentTransactionStatus.REFUNDED,
    );
  });
});

describe("idempotency: double-click / retry protection", () => {
  it("the exact same idempotency key never creates a second refund or provider call", async () => {
    const gateway = new FakeStripeGateway();
    const { orderId, paymentId } = await makePaidOrder({ amountCents: 5000 });
    const sharedKey = key();

    const [first, second] = await Promise.all([
      requestRefund(manager, orderId, { amountCents: 1500, reason: "r", idempotencyKey: sharedKey }, {}, db, gateway),
      requestRefund(manager, orderId, { amountCents: 1500, reason: "r", idempotencyKey: sharedKey }, {}, db, gateway),
    ]);
    expect(first.id).toBe(second.id);
    expect(await db.refund.count({ where: { paymentId } })).toBe(1);
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).refundedCents).toBe(1500);
  });
});

describe("concurrency: two different refunds against the same balance", () => {
  it("only lets through as much as the captured amount actually covers, and the loser never reaches the provider", async () => {
    const gateway = new FakeStripeGateway();
    const { orderId, paymentId } = await makePaidOrder({ amountCents: 5000 });

    const results = await Promise.allSettled([
      requestRefund(manager, orderId, { amountCents: 3000, reason: "a", idempotencyKey: key() }, {}, db, gateway),
      requestRefund(manager, orderId, { amountCents: 3000, reason: "b", idempotencyKey: key() }, {}, db, gateway),
    ]);
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const payment = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.refundedCents).toBe(3000);
    expect(payment.refundedCents).toBeLessThanOrEqual(5000);
    // The balance check (row lock + sum of pending) happens BEFORE any
    // provider call, so the loser must never have reached `gateway.refund` —
    // only the winner's single call is counted.
    expect(gateway.refundCallCount).toBe(1);
  });

  it("a PENDING (not-yet-settled) refund reserves its amount against a concurrent request", async () => {
    const gateway = new FakeStripeGateway();
    const pendingKey = key();
    gateway.scriptRefundOutcome(pendingKey, "pending");
    const { orderId, paymentId } = await makePaidOrder({ amountCents: 5000 });

    const pending = await requestRefund(
      manager,
      orderId,
      { amountCents: 3000, reason: "reserved by pending", idempotencyKey: pendingKey },
      {},
      db,
      gateway,
    );
    expect(pending.status).toBe(RefundStatus.PENDING);

    // Only 2000 remains (5000 - 0 confirmed - 3000 pending); this must be rejected.
    await expect(
      requestRefund(
        manager,
        orderId,
        { amountCents: 2001, reason: "should be blocked", idempotencyKey: key() },
        {},
        db,
        gateway,
      ),
    ).rejects.toBeInstanceOf(CatalogValidationError);

    expect(await db.refund.count({ where: { paymentId } })).toBe(1);
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).refundedCents).toBe(0);
  });

  it("an AMBIGUOUS-outcome refund (no provider id known) also reserves its amount", async () => {
    const gateway = new FakeStripeGateway();
    const ambiguousKey = key();
    gateway.scriptRefundOutcome(
      ambiguousKey,
      new PaymentGatewayError("socket hang up", { ambiguous: true }),
    );
    const { orderId, paymentId } = await makePaidOrder({ amountCents: 5000 });

    const ambiguous = await requestRefund(
      manager,
      orderId,
      { amountCents: 4000, reason: "reserved by ambiguous", idempotencyKey: ambiguousKey },
      {},
      db,
      gateway,
    );
    expect(ambiguous.status).toBe(RefundStatus.PENDING);
    expect(ambiguous.providerRefundId).toBeNull();
    const callsBeforeSecond = gateway.refundCallCount;

    // Only 1000 remains (5000 - 0 confirmed - 4000 pending-ambiguous).
    await expect(
      requestRefund(
        manager,
        orderId,
        { amountCents: 1001, reason: "should be blocked", idempotencyKey: key() },
        {},
        db,
        gateway,
      ),
    ).rejects.toBeInstanceOf(CatalogValidationError);

    // Rejected by the balance check before ever reaching the provider.
    expect(gateway.refundCallCount).toBe(callsBeforeSecond);
    expect(await db.refund.count({ where: { paymentId } })).toBe(1);
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).refundedCents).toBe(0);
  });
});

describe("provider outcomes: failure, pending, and ambiguous timeout", () => {
  it("a definitive provider decline marks the refund FAILED and leaves Payment/Order untouched", async () => {
    const gateway = new FakeStripeGateway();
    const declineKey = key();
    gateway.scriptRefundOutcome(declineKey, new PaymentGatewayError("card issuer declined", { ambiguous: false }));
    const { orderId, paymentId } = await makePaidOrder({ amountCents: 5000 });

    const refund = await requestRefund(
      manager,
      orderId,
      { amountCents: 1000, reason: "declined", idempotencyKey: declineKey },
      {},
      db,
      gateway,
    );
    expect(refund.status).toBe(RefundStatus.FAILED);
    expect(refund.errorMessage).toContain("declined");

    const payment = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.refundedCents).toBe(0);
    expect(payment.status).toBe(PaymentTransactionStatus.CAPTURED);
    const audit = await db.auditLog.findFirst({
      where: { entityType: "Order", entityId: orderId, action: "payment.refund.failed" },
    });
    expect(audit).not.toBeNull();
  });

  it("a provider-pending refund stays PENDING until reconciled, then settles", async () => {
    const gateway = new FakeStripeGateway();
    const pendingKey = key();
    gateway.scriptRefundOutcome(pendingKey, "pending");
    const { orderId, paymentId } = await makePaidOrder({ amountCents: 5000 });

    const refund = await requestRefund(
      manager,
      orderId,
      { amountCents: 1000, reason: "pending", idempotencyKey: pendingKey },
      {},
      db,
      gateway,
    );
    expect(refund.status).toBe(RefundStatus.PENDING);
    expect(refund.providerRefundId).not.toBeNull();
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).refundedCents).toBe(0);

    // Settles later — provider status retrieval.
    gateway.patchRefund(refund.providerRefundId!, "succeeded");
    const reconciled = await reconcileRefund(manager, refund.id, db, gateway);
    expect(reconciled.status).toBe(RefundStatus.SUCCEEDED);
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).refundedCents).toBe(1000);
  });

  it("an ambiguous (network/timeout) outcome stays PENDING — never FAILED, never a silent success", async () => {
    const gateway = new FakeStripeGateway();
    const ambiguousKey = key();
    gateway.scriptRefundOutcome(ambiguousKey, new PaymentGatewayError("socket hang up", { ambiguous: true }));
    const { orderId, paymentId } = await makePaidOrder({ amountCents: 5000 });

    const refund = await requestRefund(
      manager,
      orderId,
      { amountCents: 1000, reason: "ambiguous", idempotencyKey: ambiguousKey },
      {},
      db,
      gateway,
    );
    expect(refund.status).toBe(RefundStatus.PENDING);
    expect(refund.providerRefundId).toBeNull(); // never learned a provider id
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).refundedCents).toBe(0);

    // Reconciliation retries the SAME idempotency key — safe, never a second
    // real refund, and now we learn the outcome.
    gateway.scriptRefundOutcome(ambiguousKey, "succeeded");
    const reconciled = await reconcileRefund(manager, refund.id, db, gateway);
    expect(reconciled.status).toBe(RefundStatus.SUCCEEDED);
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).refundedCents).toBe(1000);
  });
});

describe("webhook reconciliation: duplicate and out-of-order events", () => {
  async function post(body: string, header: string) {
    const req = new Request("http://localhost/api/webhooks/stripe", {
      method: "POST",
      body,
      headers: { "stripe-signature": header },
    });
    const res = await stripeWebhook(req);
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it("a signed refund.updated event settles a pending refund; a redelivery is a no-op", async () => {
    const gateway = new FakeStripeGateway();
    __setPaymentGateway(gateway);
    const pendingKey = key();
    gateway.scriptRefundOutcome(pendingKey, "pending");
    const { orderId, paymentId } = await makePaidOrder({ amountCents: 5000 });

    const refund = await requestRefund(
      manager,
      orderId,
      { amountCents: 1000, reason: "webhook settles this", idempotencyKey: pendingKey },
      {},
      db,
      gateway,
    );
    const settled = gateway.patchRefund(refund.providerRefundId!, "succeeded");
    const evt = makeRefundEvent(settled);

    const first = await post(evt.body, evt.header);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ received: true, handled: true });
    expect((await db.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe(
      RefundStatus.SUCCEEDED,
    );
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).refundedCents).toBe(1000);

    // Redelivery of the exact same event id is a no-op.
    const second = await post(evt.body, evt.header);
    expect(second.json).toMatchObject({ received: true, duplicate: true });
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).refundedCents).toBe(1000);
  });

  it("a stale pending event arriving after success does not regress or double-count", async () => {
    const gateway = new FakeStripeGateway();
    __setPaymentGateway(gateway);
    const pendingKey = key();
    gateway.scriptRefundOutcome(pendingKey, "pending");
    const { orderId, paymentId } = await makePaidOrder({ amountCents: 5000 });

    const refund = await requestRefund(
      manager,
      orderId,
      { amountCents: 1000, reason: "out of order", idempotencyKey: pendingKey },
      {},
      db,
      gateway,
    );
    const succeeded = gateway.patchRefund(refund.providerRefundId!, "succeeded");
    const settleEvt = makeRefundEvent(succeeded);
    await post(settleEvt.body, settleEvt.header);
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).refundedCents).toBe(1000);

    // A stale "still pending" event for the SAME refund, delivered late.
    const stalePendingView = { ...succeeded, status: "pending" as const };
    const staleEvt = makeRefundEvent(stalePendingView);
    const res = await post(staleEvt.body, staleEvt.header);
    expect(res.status).toBe(200);
    // Already terminal — applyRefundOutcomeTx's guard makes this a no-op.
    expect((await db.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe(
      RefundStatus.SUCCEEDED,
    );
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).refundedCents).toBe(1000);
  });
});

describe("webhook reconciliation: early event before providerRefundId is known", () => {
  async function post(body: string, header: string) {
    const req = new Request("http://localhost/api/webhooks/stripe", {
      method: "POST",
      body,
      headers: { "stripe-signature": header },
    });
    const res = await stripeWebhook(req);
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it("an ambiguous refund is settled by a webhook carrying its metadata, verified against amount/currency/payment intent", async () => {
    const gateway = new FakeStripeGateway();
    __setPaymentGateway(gateway);
    const ambiguousKey = key();
    gateway.scriptRefundOutcome(
      ambiguousKey,
      new PaymentGatewayError("socket hang up", { ambiguous: true }),
    );
    const { orderId, paymentId } = await makePaidOrder({ amountCents: 5000 });

    const refund = await requestRefund(
      manager,
      orderId,
      { amountCents: 1500, reason: "ambiguous, then webhook settles it", idempotencyKey: ambiguousKey },
      {},
      db,
      gateway,
    );
    expect(refund.providerRefundId).toBeNull(); // never learned a provider id locally

    // Stripe DID create the refund (we just never heard back) — its object
    // carries the metadata we attached at creation time.
    const settled = {
      id: `re_fake_${randomUUID()}`,
      status: "succeeded" as const,
      amountCents: 1500,
      paymentIntentId: (await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).providerPaymentId!,
    };
    const evt = makeRefundEvent(settled, { metadata: { taekShopsRefundId: refund.id } });

    const res = await post(evt.body, evt.header);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ received: true, handled: true });

    const updated = await db.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(updated.status).toBe(RefundStatus.SUCCEEDED);
    expect(updated.providerRefundId).toBe(settled.id);
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).refundedCents).toBe(1500);
  });

  it("a mismatched amount in the metadata-linked event is refused, not applied", async () => {
    const gateway = new FakeStripeGateway();
    __setPaymentGateway(gateway);
    const ambiguousKey = key();
    gateway.scriptRefundOutcome(
      ambiguousKey,
      new PaymentGatewayError("socket hang up", { ambiguous: true }),
    );
    const { orderId, paymentId } = await makePaidOrder({ amountCents: 5000 });

    const refund = await requestRefund(
      manager,
      orderId,
      { amountCents: 1500, reason: "ambiguous", idempotencyKey: ambiguousKey },
      {},
      db,
      gateway,
    );

    // Wrong amount for this refund — must NOT be applied even though the
    // metadata "points" at the right local row.
    const mismatched = {
      id: `re_fake_${randomUUID()}`,
      status: "succeeded" as const,
      amountCents: 999,
      paymentIntentId: (await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).providerPaymentId!,
    };
    const evt = makeRefundEvent(mismatched, { metadata: { taekShopsRefundId: refund.id } });
    const res = await post(evt.body, evt.header);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ received: true, handled: true }); // event processed, but no-op

    const unchanged = await db.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(unchanged.status).toBe(RefundStatus.PENDING); // untouched
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).refundedCents).toBe(0);
  });
});

describe("reconcileRefund: safe retry window for an unresolved ambiguous refund", () => {
  it("refuses to blindly resubmit once past the safe retry window, without calling the provider again", async () => {
    const gateway = new FakeStripeGateway();
    const ambiguousKey = key();
    gateway.scriptRefundOutcome(
      ambiguousKey,
      new PaymentGatewayError("socket hang up", { ambiguous: true }),
    );
    const { orderId } = await makePaidOrder({ amountCents: 5000 });

    const refund = await requestRefund(
      manager,
      orderId,
      { amountCents: 1000, reason: "ambiguous, never resolved", idempotencyKey: ambiguousKey },
      {},
      db,
      gateway,
    );
    expect(refund.status).toBe(RefundStatus.PENDING);
    const callsBeforeReconcile = gateway.refundCallCount;

    // Simulate this refund having sat unresolved for well over Stripe's
    // documented minimum 24h idempotency-key retention window.
    await db.refund.update({
      where: { id: refund.id },
      data: { createdAt: new Date(Date.now() - 13 * 60 * 60 * 1000) },
    });

    await expect(reconcileRefund(manager, refund.id, db, gateway)).rejects.toBeInstanceOf(
      CatalogValidationError,
    );
    // Refused before ever touching the provider again.
    expect(gateway.refundCallCount).toBe(callsBeforeReconcile);
    expect((await db.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe(
      RefundStatus.PENDING,
    );
  });

  it("still safely retries within the window", async () => {
    const gateway = new FakeStripeGateway();
    const ambiguousKey = key();
    gateway.scriptRefundOutcome(
      ambiguousKey,
      new PaymentGatewayError("socket hang up", { ambiguous: true }),
    );
    const { orderId, paymentId } = await makePaidOrder({ amountCents: 5000 });

    const refund = await requestRefund(
      manager,
      orderId,
      { amountCents: 1000, reason: "ambiguous, resolved in time", idempotencyKey: ambiguousKey },
      {},
      db,
      gateway,
    );

    gateway.scriptRefundOutcome(ambiguousKey, "succeeded");
    const reconciled = await reconcileRefund(manager, refund.id, db, gateway);
    expect(reconciled.status).toBe(RefundStatus.SUCCEEDED);
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).refundedCents).toBe(1000);
  });
});

describe("reconcileRefund: bounded retry uses identical provider parameters", () => {
  it("sanity check — the fake gateway itself rejects a reused key with different parameters", async () => {
    const gateway = new FakeStripeGateway();
    const sharedKey = key();
    await gateway.refund({ paymentIntentId: "pi_a", amountCents: 1000, idempotencyKey: sharedKey });
    await expect(
      gateway.refund({ paymentIntentId: "pi_a", amountCents: 999, idempotencyKey: sharedKey }),
    ).rejects.toMatchObject({ ambiguous: false });
  });

  it("reconcileRefund's retry reuses the same idempotency key, amount, payment intent, and metadata — never rejected as a mismatch", async () => {
    const gateway = new FakeStripeGateway();
    const ambiguousKey = key();
    gateway.scriptRefundOutcome(
      ambiguousKey,
      new PaymentGatewayError("socket hang up", { ambiguous: true }),
    );
    const { orderId, paymentId, providerPaymentId } = await makePaidOrder({ amountCents: 5000 });

    const refund = await requestRefund(
      manager,
      orderId,
      { amountCents: 1234, reason: "ambiguous, retried with identical params", idempotencyKey: ambiguousKey },
      {},
      db,
      gateway,
    );
    expect(refund.status).toBe(RefundStatus.PENDING);
    expect(refund.providerRefundId).toBeNull();

    // The fake gateway's fingerprint check (amount, payment intent, metadata)
    // is armed from the very first (ambiguous) attempt. If `reconcileRefund`
    // reconstructed anything differently, this would throw a definitive
    // mismatch error instead of settling — proving end-to-end, not just by
    // inspection, that the retry is parameter-faithful.
    gateway.scriptRefundOutcome(ambiguousKey, "succeeded");
    const reconciled = await reconcileRefund(manager, refund.id, db, gateway);
    expect(reconciled.status).toBe(RefundStatus.SUCCEEDED);
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).refundedCents).toBe(1234);
    expect(providerPaymentId).toBeTruthy(); // sanity: this order really had one
  });

  it("refuses to retry (rather than guess) when the payment has no recorded provider reference", async () => {
    const gateway = new FakeStripeGateway();
    const ambiguousKey = key();
    gateway.scriptRefundOutcome(
      ambiguousKey,
      new PaymentGatewayError("socket hang up", { ambiguous: true }),
    );
    const { orderId, paymentId } = await makePaidOrder({ amountCents: 5000 });

    const refund = await requestRefund(
      manager,
      orderId,
      { amountCents: 1000, reason: "ambiguous", idempotencyKey: ambiguousKey },
      {},
      db,
      gateway,
    );
    const callsBeforeReconcile = gateway.refundCallCount;

    // Simulate missing evidence of the original provider reference (should
    // never happen in practice — `requestRefund` requires it up front — but
    // `reconcileRefund` must still refuse rather than send a malformed
    // request if it somehow did).
    await db.payment.update({ where: { id: paymentId }, data: { providerPaymentId: null } });

    await expect(reconcileRefund(manager, refund.id, db, gateway)).rejects.toBeInstanceOf(
      CatalogValidationError,
    );
    expect(gateway.refundCallCount).toBe(callsBeforeReconcile);
  });
});

describe("inventory is never touched by a refund", () => {
  it("stock, reservation, and movement history are byte-for-byte unchanged", async () => {
    const gateway = new FakeStripeGateway();
    const variant = await makeVariant(7);
    const { orderId, paymentId } = await makePaidOrder({ amountCents: 5000, variant });

    const before = await db.inventoryItem.findUniqueOrThrow({ where: { id: variant.inventoryItemId } });
    const movementsBefore = await db.stockMovement.count({
      where: { inventoryItemId: variant.inventoryItemId },
    });

    await requestRefund(
      manager,
      orderId,
      { amountCents: 5000, reason: "full refund, goods kept for now", idempotencyKey: key() },
      {},
      db,
      gateway,
    );

    const after = await db.inventoryItem.findUniqueOrThrow({ where: { id: variant.inventoryItemId } });
    expect(after).toEqual(before);
    expect(
      await db.stockMovement.count({ where: { inventoryItemId: variant.inventoryItemId } }),
    ).toBe(movementsBefore);
    expect(
      await db.stockMovement.count({
        where: { inventoryItemId: variant.inventoryItemId, type: StockMovementType.RETURN },
      }),
    ).toBe(0);
    expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe(
      PaymentTransactionStatus.REFUNDED,
    );
  });
});

