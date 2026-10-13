import { StockMovementType } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { addToCart } from "@/server/cart/cart-service";
import { placeOrder } from "@/server/orders/checkout-service";
import { startPayment } from "@/server/orders/payment-service";
import { __setPaymentGateway } from "@/server/domain/payments";
import { POST as stripeWebhook } from "@/app/api/webhooks/stripe/route";
import { cleanup, db, ledgerSums, makeVariant } from "./helpers/db";
import {
  cleanupCheckout,
  ensureTaxAndShippingConfig,
  makeCart,
  placeOrderInput,
  type TestShippingConfig,
} from "./helpers/checkout";
import {
  FakeStripeGateway,
  cleanupOwnedWebhookEvents,
  makeEvent as makeRawEvent,
  signEvent,
} from "./helpers/payments";

let cfg: TestShippingConfig;
let gateway: FakeStripeGateway;

/**
 * `WebhookEvent` rows have no relation back to a test fixture (no order id, no
 * namespaced prefix) — the only safe way to clean up exactly what THIS run
 * created is to record every event id this file generates and delete only
 * those, by exact id. Never widen this to a prefix or a blanket `deleteMany`:
 * the webhook table is shared with real application traffic, and an
 * unscoped delete here previously erased unrelated webhook history.
 */
const ownedWebhookEventIds = new Set<string>();

/** Wraps `makeEvent` so every generated event id is tracked for teardown. */
function makeEvent(...args: Parameters<typeof makeRawEvent>): ReturnType<typeof makeRawEvent> {
  const event = makeRawEvent(...args);
  ownedWebhookEventIds.add(event.eventId);
  return event;
}

beforeAll(async () => {
  cfg = await ensureTaxAndShippingConfig();
});
afterEach(() => {
  __setPaymentGateway(null);
});
afterAll(async () => {
  await cleanupOwnedWebhookEvents(db, ownedWebhookEventIds);
  await cleanupCheckout();
  await cleanup();
  await db.$disconnect();
});

async function pendingOrder(onHand: number, qty: number) {
  const v = await makeVariant({ onHand });
  const cart = await makeCart();
  await addToCart({ token: cart.token }, { variantId: v.variantId, quantity: qty });
  const order = await placeOrder({ token: cart.token }, placeOrderInput(cfg.shippingMethodId));
  return { v, order };
}

async function post(
  body: string,
  header: string | null,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    body,
    headers: header ? { "stripe-signature": header } : {},
  });
  const res = await stripeWebhook(req);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function orderRow(id: string) {
  return db.order.findUniqueOrThrow({
    where: { id },
    select: { status: true, paymentStatus: true },
  });
}
async function itemRow(inventoryItemId: string) {
  return db.inventoryItem.findUniqueOrThrow({
    where: { id: inventoryItemId },
    select: { quantityOnHand: true, quantityReserved: true },
  });
}
async function movementCount(inventoryItemId: string, type: StockMovementType) {
  return db.stockMovement.count({ where: { inventoryItemId, type } });
}

describe("startPayment", () => {
  it("derives the amount from the frozen order total and creates one Payment row", async () => {
    gateway = new FakeStripeGateway();
    __setPaymentGateway(gateway);
    const { order } = await pendingOrder(20, 2); // 2*$10 + $12 ship + 13% tax on $20 = $34.60

    const first = await startPayment(order.orderNumber, { justPlaced: true });
    const second = await startPayment(order.orderNumber, { justPlaced: true });

    expect(first.amountCents).toBe(3460);
    expect(first.clientSecret).toBe(second.clientSecret); // reused, not re-created
    const payments = await db.payment.findMany({ where: { orderId: order.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ amountCents: 3460, currency: "CAD", provider: "stripe" });
  });
});

describe("stripe webhook — success", () => {
  it("payment_intent.succeeded → order PAID + CONFIRMED, stock committed once, ledger reconciles", async () => {
    gateway = new FakeStripeGateway();
    __setPaymentGateway(gateway);
    const { v, order } = await pendingOrder(12, 3);
    const start = await startPayment(order.orderNumber, { justPlaced: true });
    const piId = (await db.payment.findUniqueOrThrow({ where: { orderId: order.id } }))
      .providerPaymentId!;
    gateway.patch(piId, { status: "succeeded", amountReceived: start.amountCents });

    const pi = await gateway.retrievePaymentIntent(piId);
    const evt = makeEvent("payment_intent.succeeded", pi);
    const res = await post(evt.body, evt.header);

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ received: true, handled: true });
    expect(await orderRow(order.id)).toEqual({ status: "CONFIRMED", paymentStatus: "PAID" });
    expect(await itemRow(v.inventoryItemId)).toEqual({ quantityOnHand: 9, quantityReserved: 0 });
    expect(await movementCount(v.inventoryItemId, StockMovementType.SALE)).toBe(1);
    expect((await ledgerSums(v.inventoryItemId)).onHand).toBe(9);
    expect(await db.webhookEvent.count({ where: { eventId: evt.eventId } })).toBe(1);
    expect(
      await db.auditLog.count({ where: { action: "payment.succeeded", entityId: order.id } }),
    ).toBe(1);
  });

  it("a redelivered / replayed event is a no-op — no second stock or ledger effect", async () => {
    gateway = new FakeStripeGateway();
    __setPaymentGateway(gateway);
    const { v, order } = await pendingOrder(10, 2);
    await startPayment(order.orderNumber, { justPlaced: true });
    const piId = (await db.payment.findUniqueOrThrow({ where: { orderId: order.id } }))
      .providerPaymentId!;
    gateway.patch(piId, { status: "succeeded" });
    const pi = await gateway.retrievePaymentIntent(piId);
    const evt = makeEvent("payment_intent.succeeded", pi);

    const r1 = await post(evt.body, evt.header);
    const r2 = await post(evt.body, evt.header); // exact same event id
    const r3 = await post(evt.body, evt.header);

    expect(r1.json).toMatchObject({ handled: true });
    expect(r2.json).toMatchObject({ received: true, duplicate: true });
    expect(r3.json).toMatchObject({ received: true, duplicate: true });
    expect(await movementCount(v.inventoryItemId, StockMovementType.SALE)).toBe(1);
    expect(await itemRow(v.inventoryItemId)).toEqual({ quantityOnHand: 8, quantityReserved: 0 });
  });

  it("concurrent deliveries of the same event commit stock exactly once", async () => {
    gateway = new FakeStripeGateway();
    __setPaymentGateway(gateway);
    const { v, order } = await pendingOrder(10, 4);
    await startPayment(order.orderNumber, { justPlaced: true });
    const piId = (await db.payment.findUniqueOrThrow({ where: { orderId: order.id } }))
      .providerPaymentId!;
    gateway.patch(piId, { status: "succeeded" });
    const pi = await gateway.retrievePaymentIntent(piId);
    const evt = makeEvent("payment_intent.succeeded", pi);

    const results = await Promise.all([
      post(evt.body, evt.header),
      post(evt.body, evt.header),
      post(evt.body, evt.header),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(await movementCount(v.inventoryItemId, StockMovementType.SALE)).toBe(1);
    expect(await itemRow(v.inventoryItemId)).toEqual({ quantityOnHand: 6, quantityReserved: 0 });
  });
});

describe("stripe webhook — failure & security", () => {
  it("rejects an invalid signature with 400 and writes nothing", async () => {
    gateway = new FakeStripeGateway();
    __setPaymentGateway(gateway);
    const { v, order } = await pendingOrder(10, 2);
    await startPayment(order.orderNumber, { justPlaced: true });
    const piId = (await db.payment.findUniqueOrThrow({ where: { orderId: order.id } }))
      .providerPaymentId!;
    gateway.patch(piId, { status: "succeeded" });
    const pi = await gateway.retrievePaymentIntent(piId);
    const { body, eventId } = makeEvent("payment_intent.succeeded", pi);
    const webhookEventsBefore = await db.webhookEvent.count();

    const bad = await post(body, "t=1,v1=deadbeef");
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ error: "invalid_signature" });

    const tampered = body.replace('"amount":' + pi.amount, '"amount":1');
    const stillBad = await post(tampered, signEvent(body)); // header for the un-tampered body
    expect(stillBad.status).toBe(400);

    expect(await orderRow(order.id)).toEqual({ status: "PENDING", paymentStatus: "UNPAID" });
    expect(await itemRow(v.inventoryItemId)).toEqual({ quantityOnHand: 10, quantityReserved: 2 });
    // The rejected requests wrote nothing.
    expect(await db.webhookEvent.count()).toBe(webhookEventsBefore);
    expect(await db.webhookEvent.count({ where: { eventId } })).toBe(0);
  });

  it("payment_intent.payment_failed → order FAILED + CANCELLED, reservation released", async () => {
    gateway = new FakeStripeGateway();
    __setPaymentGateway(gateway);
    const { v, order } = await pendingOrder(10, 3);
    await startPayment(order.orderNumber, { justPlaced: true });
    const piId = (await db.payment.findUniqueOrThrow({ where: { orderId: order.id } }))
      .providerPaymentId!;
    const pi = await gateway.retrievePaymentIntent(piId);
    const evt = makeEvent("payment_intent.payment_failed", pi);

    const res = await post(evt.body, evt.header);
    expect(res.status).toBe(200);
    expect(await orderRow(order.id)).toEqual({ status: "CANCELLED", paymentStatus: "FAILED" });
    expect(await itemRow(v.inventoryItemId)).toEqual({ quantityOnHand: 10, quantityReserved: 0 });
    expect((await ledgerSums(v.inventoryItemId)).reserved).toBe(0);
    expect(await db.payment.findUniqueOrThrow({ where: { orderId: order.id } })).toMatchObject({
      status: "FAILED",
    });
  });

  it("rejects an amount that does not match the frozen order total", async () => {
    gateway = new FakeStripeGateway();
    __setPaymentGateway(gateway);
    const { v, order } = await pendingOrder(10, 2);
    await startPayment(order.orderNumber, { justPlaced: true });
    const piId = (await db.payment.findUniqueOrThrow({ where: { orderId: order.id } }))
      .providerPaymentId!;
    gateway.patch(piId, { status: "succeeded", amount: 1, amountReceived: 1 }); // tampered/low

    const pi = await gateway.retrievePaymentIntent(piId);
    const evt = makeEvent("payment_intent.succeeded", pi);
    const res = await post(evt.body, evt.header);

    expect(res.status).toBe(200);
    expect(await orderRow(order.id)).toEqual({ status: "PENDING", paymentStatus: "UNPAID" });
    expect(await movementCount(v.inventoryItemId, StockMovementType.SALE)).toBe(0);
    expect(await itemRow(v.inventoryItemId)).toEqual({ quantityOnHand: 10, quantityReserved: 2 });
    expect(
      await db.auditLog.count({ where: { action: "payment.amount_mismatch", entityId: order.id } }),
    ).toBe(1);
  });
});

describe("stripe webhook — out-of-order events", () => {
  it("a failure that arrives after a success does not release committed stock", async () => {
    gateway = new FakeStripeGateway();
    __setPaymentGateway(gateway);
    const { v, order } = await pendingOrder(10, 2);
    await startPayment(order.orderNumber, { justPlaced: true });
    const piId = (await db.payment.findUniqueOrThrow({ where: { orderId: order.id } }))
      .providerPaymentId!;
    gateway.patch(piId, { status: "succeeded" });
    const pi = await gateway.retrievePaymentIntent(piId);

    await post(...withEvent(makeEvent("payment_intent.succeeded", pi)));
    const failed = makeEvent("payment_intent.payment_failed", pi);
    const res = await post(failed.body, failed.header);

    expect(res.status).toBe(200);
    expect(await orderRow(order.id)).toEqual({ status: "CONFIRMED", paymentStatus: "PAID" });
    expect(await itemRow(v.inventoryItemId)).toEqual({ quantityOnHand: 8, quantityReserved: 0 });
    expect(await movementCount(v.inventoryItemId, StockMovementType.SALE)).toBe(1);
    expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(0);
  });

  it("a success that arrives after a cancellation does not commit stock (refund required)", async () => {
    gateway = new FakeStripeGateway();
    __setPaymentGateway(gateway);
    const { v, order } = await pendingOrder(10, 2);
    await startPayment(order.orderNumber, { justPlaced: true });
    const piId = (await db.payment.findUniqueOrThrow({ where: { orderId: order.id } }))
      .providerPaymentId!;
    const pi = await gateway.retrievePaymentIntent(piId);

    await post(...withEvent(makeEvent("payment_intent.payment_failed", pi)));
    gateway.patch(piId, { status: "succeeded" });
    const succeeded = makeEvent(
      "payment_intent.succeeded",
      await gateway.retrievePaymentIntent(piId),
    );
    const res = await post(succeeded.body, succeeded.header);

    expect(res.status).toBe(200);
    expect(await orderRow(order.id)).toEqual({ status: "CANCELLED", paymentStatus: "FAILED" });
    expect(await movementCount(v.inventoryItemId, StockMovementType.SALE)).toBe(0);
    expect(
      await db.auditLog.count({ where: { action: "payment.late_success", entityId: order.id } }),
    ).toBe(1);
  });
});

function withEvent(e: { body: string; header: string }): [string, string] {
  return [e.body, e.header];
}
