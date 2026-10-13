import { OrderEmailStatus, OrderEmailType, OrderStatus, PaymentStatus } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { addToCart } from "@/server/cart/cart-service";
import { placeOrder } from "@/server/orders/checkout-service";
import { startPayment } from "@/server/orders/payment-service";
import {
  changeOrderFulfillmentStatus,
  changeOrderStatus,
} from "@/server/orders/order-management-service";
import { __setPaymentGateway } from "@/server/domain/payments";
import {
  __setOrderMailer,
  claimNextEmailJob,
  drainEmailQueue,
  kickEmailDispatch,
} from "@/server/notifications";
import { POST as stripeWebhook } from "@/app/api/webhooks/stripe/route";
import { cleanup, db, ensureActor, makeVariant } from "./helpers/db";
import {
  cleanupCheckout,
  ensureTaxAndShippingConfig,
  makeCart,
  placeOrderInput,
} from "./helpers/checkout";
import { FakeStripeGateway, makeEvent, cleanupOwnedWebhookEvents } from "./helpers/payments";
import { FakeOrderMailer } from "./helpers/order-mailer";

/**
 * Phase 8 transactional order emails — against a real, isolated database, the
 * real `payment-service.ts` / `order-management-service.ts` / webhook route,
 * and a real `email-outbox.ts`. A `FakeOrderMailer` stands in for delivery —
 * this proves the application's own outbox/worker logic, never a real
 * transport. Own namespace: `customerEmail` contains "phase8emails".
 */

const TEST_EMAIL = "buyer.phase8emails@taek.local";

let cfg: Awaited<ReturnType<typeof ensureTaxAndShippingConfig>>;
const ownedWebhookEventIds = new Set<string>();

beforeAll(async () => {
  cfg = await ensureTaxAndShippingConfig();
  await ensureActor();
});

// Every test in this file gets a fresh `FakeOrderMailer` by default — never
// the real `LocalPreviewOrderMailer` (which would write an actual local
// preview file as a side effect of any test that merely triggers a payment
// or fulfilment change, whether or not that test cares about the mailer).
// Tests that DO care fetch it back via `getOrderMailer()`.
beforeEach(() => {
  __setOrderMailer(new FakeOrderMailer());
});

afterEach(() => {
  __setPaymentGateway(null);
  __setOrderMailer(null);
});

afterAll(async () => {
  await cleanupOwnedWebhookEvents(db, ownedWebhookEventIds);
  const orders = await db.order.findMany({
    where: { customerEmail: TEST_EMAIL },
    select: { id: true },
  });
  await db.auditLog.deleteMany({ where: { entityId: { in: orders.map((o) => o.id) } } });
  await db.order.deleteMany({ where: { customerEmail: TEST_EMAIL } }); // cascades OrderEmail rows
  await cleanupCheckout();
  await cleanup();
  await db.$disconnect();
});

/** A real, full-pipeline pending order — items, tax, shipping address, the works. */
async function pendingOrder(onHand: number, qty: number) {
  const v = await makeVariant({ onHand });
  const cart = await makeCart();
  await addToCart({ token: cart.token }, { variantId: v.variantId, quantity: qty });
  const order = await placeOrder(
    { token: cart.token },
    placeOrderInput(cfg.shippingMethodId, { email: TEST_EMAIL }),
  );
  return { v, order };
}

async function payAndSettle(orderId: string, gateway: FakeStripeGateway) {
  const order = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { orderNumber: true },
  });
  const start = await startPayment(order.orderNumber, { justPlaced: true });
  const piId = (await db.payment.findUniqueOrThrow({ where: { orderId } })).providerPaymentId!;
  gateway.patch(piId, { status: "succeeded", amountReceived: start.amountCents });
  const pi = await gateway.retrievePaymentIntent(piId);
  const evt = makeEvent("payment_intent.succeeded", pi);
  ownedWebhookEventIds.add(evt.eventId);
  const req = new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    body: evt.body,
    headers: { "stripe-signature": evt.header },
  });
  const res = await stripeWebhook(req);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function orderEmailRows(orderId: string) {
  return db.orderEmail.findMany({ where: { orderId } });
}

describe("event eligibility", () => {
  it("payment success enqueues exactly one ORDER_CONFIRMATION job", async () => {
    const gateway = new FakeStripeGateway();
    __setPaymentGateway(gateway);
    const mailer = new FakeOrderMailer();
    __setOrderMailer(mailer);
    const { order } = await pendingOrder(10, 1);

    const res = await payAndSettle(order.id, gateway);
    expect(res.status).toBe(200);

    const rows = await orderEmailRows(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: OrderEmailType.ORDER_CONFIRMATION });
  });

  it("fulfilment reaching FULFILLED enqueues exactly one SHIPPING_NOTIFICATION job", async () => {
    const gateway = new FakeStripeGateway();
    __setPaymentGateway(gateway);
    const mailer = new FakeOrderMailer();
    __setOrderMailer(mailer);
    const actor = await ensureActor();
    const { order } = await pendingOrder(10, 1);
    await payAndSettle(order.id, gateway);

    await changeOrderFulfillmentStatus(actor, order.id, "FULFILLED");

    const rows = await orderEmailRows(order.id);
    const shipped = rows.filter((r) => r.type === OrderEmailType.SHIPPING_NOTIFICATION);
    expect(shipped).toHaveLength(1);
  });

  it("no notification on an unrelated fulfilment transition (partial)", async () => {
    const gateway = new FakeStripeGateway();
    __setPaymentGateway(gateway);
    const actor = await ensureActor();
    const { order } = await pendingOrder(10, 1);
    await payAndSettle(order.id, gateway);

    await changeOrderFulfillmentStatus(actor, order.id, "PARTIALLY_FULFILLED");

    const rows = await orderEmailRows(order.id);
    expect(rows.filter((r) => r.type === OrderEmailType.SHIPPING_NOTIFICATION)).toHaveLength(0);
  });

  it("no notification on an order-status-only transition", async () => {
    const gateway = new FakeStripeGateway();
    __setPaymentGateway(gateway);
    const actor = await ensureActor();
    const { order } = await pendingOrder(10, 1);
    await payAndSettle(order.id, gateway); // already enqueues 1 ORDER_CONFIRMATION row
    const baseline = await orderEmailRows(order.id);

    await changeOrderStatus(actor, order.id, OrderStatus.PROCESSING);

    // Unchanged — an order-status-only transition never enqueues anything of
    // its own, on top of whatever payment success already queued.
    expect(await orderEmailRows(order.id)).toHaveLength(baseline.length);
  });
});

describe("transaction rollback produces no job", () => {
  it("a job inserted inside a transaction that then throws never persists", async () => {
    const { order } = await pendingOrder(10, 1);
    const { enqueueOrderEmailTx } = await import("@/server/notifications");

    await expect(
      db.$transaction(async (tx) => {
        await enqueueOrderEmailTx(tx, order.id, OrderEmailType.ORDER_CONFIRMATION);
        throw new Error("forced rollback");
      }),
    ).rejects.toThrow("forced rollback");

    expect(await orderEmailRows(order.id)).toHaveLength(0);
  });
});

describe("duplicate events never create a second job", () => {
  it("a redelivered payment_intent.succeeded event is a no-op for the email job too", async () => {
    const gateway = new FakeStripeGateway();
    __setPaymentGateway(gateway);
    const mailer = new FakeOrderMailer();
    __setOrderMailer(mailer);
    const { order } = await pendingOrder(10, 1);

    const order2 = await db.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { orderNumber: true },
    });
    const start = await startPayment(order2.orderNumber, { justPlaced: true });
    const piId = (await db.payment.findUniqueOrThrow({ where: { orderId: order.id } }))
      .providerPaymentId!;
    gateway.patch(piId, { status: "succeeded", amountReceived: start.amountCents });
    const pi = await gateway.retrievePaymentIntent(piId);
    const evt = makeEvent("payment_intent.succeeded", pi);
    ownedWebhookEventIds.add(evt.eventId);

    async function post() {
      const req = new Request("http://localhost/api/webhooks/stripe", {
        method: "POST",
        body: evt.body,
        headers: { "stripe-signature": evt.header },
      });
      return stripeWebhook(req);
    }

    const first = await post();
    const second = await post(); // exact redelivery, same event id
    expect(first.status).toBe(200);
    expect((await second.json()) as Record<string, unknown>).toMatchObject({ duplicate: true });

    expect(await orderEmailRows(order.id)).toHaveLength(1);
  });

  it("calling changeOrderFulfillmentStatus at the already-reached target is a no-op for the job too", async () => {
    const gateway = new FakeStripeGateway();
    __setPaymentGateway(gateway);
    const mailer = new FakeOrderMailer();
    __setOrderMailer(mailer);
    const actor = await ensureActor();
    const { order } = await pendingOrder(10, 1);
    await payAndSettle(order.id, gateway);

    await changeOrderFulfillmentStatus(actor, order.id, "FULFILLED");
    await changeOrderFulfillmentStatus(actor, order.id, "FULFILLED"); // no-op branch

    expect(
      (await orderEmailRows(order.id)).filter(
        (r) => r.type === OrderEmailType.SHIPPING_NOTIFICATION,
      ),
    ).toHaveLength(1);
  });
});

describe("concurrent worker claims", () => {
  it("two concurrent claims against two pending jobs each get a different row", async () => {
    const { order: orderA } = await pendingOrder(5, 1);
    const { order: orderB } = await pendingOrder(5, 1);
    await db.orderEmail.create({
      data: { orderId: orderA.id, type: OrderEmailType.ORDER_CONFIRMATION },
    });
    await db.orderEmail.create({
      data: { orderId: orderB.id, type: OrderEmailType.ORDER_CONFIRMATION },
    });

    const [first, second] = await Promise.all([claimNextEmailJob(db), claimNextEmailJob(db)]);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.id).not.toBe(second!.id);

    const third = await claimNextEmailJob(db);
    expect(third).toBeNull();
  });
});

describe("retry, backoff, and recovery", () => {
  it("a transport failure schedules a future retry, not an immediate re-send", async () => {
    const { order } = await pendingOrder(5, 1);
    await db.orderEmail.create({
      data: { orderId: order.id, type: OrderEmailType.ORDER_CONFIRMATION },
    });
    const mailer = new FakeOrderMailer();
    mailer.scriptFailures(1);
    __setOrderMailer(mailer);

    const result = await drainEmailQueue(db);
    expect(result).toEqual({ claimed: 1, sent: 0, notSent: 1 });

    const row = await db.orderEmail.findUniqueOrThrow({
      where: { orderId_type: { orderId: order.id, type: OrderEmailType.ORDER_CONFIRMATION } },
    });
    expect(row.status).toBe(OrderEmailStatus.PENDING);
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    // A second drain right away finds nothing due yet.
    expect(await drainEmailQueue(db)).toEqual({ claimed: 0, sent: 0, notSent: 0 });

    // Simulate the backoff window having elapsed, then it succeeds.
    await db.orderEmail.update({
      where: { id: row.id },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    const finalResult = await drainEmailQueue(db);
    expect(finalResult).toEqual({ claimed: 1, sent: 1, notSent: 0 });
    // Two real transport attempts total (the failed one, then the retry) —
    // both carrying the SAME idempotency key, proving it is stable across
    // the retry rather than regenerated per attempt.
    expect(mailer.calls).toHaveLength(2);
    expect(mailer.calls[0]!.idempotencyKey).toBe(row.idempotencyKey);
    expect(mailer.calls[1]!.idempotencyKey).toBe(row.idempotencyKey);
  });

  it("a job whose maxAttempts is exhausted becomes terminally FAILED, never retried again", async () => {
    const { order } = await pendingOrder(5, 1);
    const created = await db.orderEmail.create({
      data: { orderId: order.id, type: OrderEmailType.ORDER_CONFIRMATION, maxAttempts: 1 },
    });
    const mailer = new FakeOrderMailer();
    mailer.scriptFailures(5); // more failures than maxAttempts — proves the cap, not the script, ends it
    __setOrderMailer(mailer);

    await drainEmailQueue(db);
    const row = await db.orderEmail.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.status).toBe(OrderEmailStatus.FAILED);
    expect(row.attempts).toBe(1);

    // Even after "time passes," a FAILED (terminal) row is never re-claimed.
    await db.orderEmail.update({
      where: { id: created.id },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    expect(await claimNextEmailJob(db)).toBeNull();
  });

  it("recovers a job whose claiming worker crashed before resolving it", async () => {
    const { order } = await pendingOrder(5, 1);
    const created = await db.orderEmail.create({
      data: { orderId: order.id, type: OrderEmailType.ORDER_CONFIRMATION },
    });
    // Simulate a worker that claimed this job a while ago and then crashed —
    // never reached SENT or FAILED.
    await db.orderEmail.update({
      where: { id: created.id },
      data: {
        status: OrderEmailStatus.SENDING,
        claimedAt: new Date(Date.now() - 10 * 60_000),
        claimedBy: "crashed-worker",
      },
    });

    const claimed = await claimNextEmailJob(db);
    expect(claimed?.id).toBe(created.id);
  });

  it("does NOT reclaim a SENDING job whose claim is still fresh", async () => {
    const { order } = await pendingOrder(5, 1);
    const created = await db.orderEmail.create({
      data: { orderId: order.id, type: OrderEmailType.ORDER_CONFIRMATION },
    });
    await db.orderEmail.update({
      where: { id: created.id },
      data: { status: OrderEmailStatus.SENDING, claimedAt: new Date(), claimedBy: "still-working" },
    });

    expect(await claimNextEmailJob(db)).toBeNull();
  });
});

describe("transport failure never interferes with a successful payment", () => {
  it("a webhook whose best-effort dispatch kick fails still confirms the payment (200, PAID, CONFIRMED)", async () => {
    const gateway = new FakeStripeGateway();
    __setPaymentGateway(gateway);
    const mailer = new FakeOrderMailer();
    mailer.scriptFailures(1);
    __setOrderMailer(mailer);
    const { order } = await pendingOrder(5, 1);

    const res = await payAndSettle(order.id, gateway);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ received: true, handled: true });

    const fresh = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.paymentStatus).toBe(PaymentStatus.PAID);
    expect(fresh.status).toBe(OrderStatus.CONFIRMED);

    // The job itself survives, PENDING for a later retry — not lost.
    const rows = await orderEmailRows(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe(OrderEmailStatus.PENDING);
  });

  it("kickEmailDispatch itself never throws even when claiming explodes", async () => {
    const badDb = {
      $transaction: () => Promise.reject(new Error("db exploded")),
    } as unknown as typeof db;
    await expect(kickEmailDispatch(badDb)).resolves.toBeUndefined();
  });
});
