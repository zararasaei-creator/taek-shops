import { OrderStatus, PaymentStatus, StockMovementType } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { addToCart } from "@/server/cart/cart-service";
import { placeOrder } from "@/server/orders/checkout-service";
import { startPayment } from "@/server/orders/payment-service";
import { applyOrderStatusTransition } from "@/server/orders/order-inventory";
import { changeOrderStatus } from "@/server/orders/order-management-service";
import { cancelPendingOrder } from "@/server/orders/order-cancellation";
import { runOrderExpirySweep, type ExpiryPolicy } from "@/server/orders/order-expiry";
import { ConflictError } from "@/server/catalog/errors";
import { PaymentGatewayError, __setPaymentGateway } from "@/server/domain/payments";
import { POST as stripeWebhook } from "@/app/api/webhooks/stripe/route";
import { cleanup, db, ensureActor, makeVariant, type TestActor } from "./helpers/db";
import {
  cleanupCheckout,
  ensureTaxAndShippingConfig,
  makeCart,
  placeOrderInput,
  type TestShippingConfig,
} from "./helpers/checkout";
import { FakeStripeGateway, cleanupOwnedWebhookEvents, makeEvent as makeRawEvent } from "./helpers/payments";

/**
 * Admin cancellation of a PENDING order is provider-aware (`order-cancellation.ts`)
 * and the structural invariant lives in `applyOrderStatusTransitionTx`: stock is
 * never released while a payment against the order could still be payable or
 * succeed. Real checkout-created orders, real DB, `FakeStripeGateway` only.
 */

let cfg: TestShippingConfig;
let actor: TestActor;
const ownedWebhookEventIds = new Set<string>();
const IMMEDIATE: ExpiryPolicy = { minAgeMs: -60_000, claimsActiveSince: new Date("2000-01-01T00:00:00Z") };

function makeEvent(...args: Parameters<typeof makeRawEvent>): ReturnType<typeof makeRawEvent> {
  const event = makeRawEvent(...args);
  ownedWebhookEventIds.add(event.eventId);
  return event;
}

beforeAll(async () => {
  cfg = await ensureTaxAndShippingConfig();
  actor = await ensureActor();
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

/** A pending order with a real, linked, still-payable PaymentIntent (via the real startPayment). */
async function orderWithLinkedIntent(gateway: FakeStripeGateway, onHand = 10, qty = 1) {
  __setPaymentGateway(gateway);
  const { v, order } = await pendingOrder(onHand, qty);
  await startPayment(order.orderNumber, { justPlaced: true }, {}, db, gateway);
  const piId = (await db.payment.findUniqueOrThrow({ where: { orderId: order.id } })).providerPaymentId!;
  return { v, order, piId };
}

async function orderRow(id: string) {
  return db.order.findUniqueOrThrow({ where: { id }, select: { status: true, paymentStatus: true } });
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
async function post(body: string, header: string) {
  const res = await stripeWebhook(
    new Request("http://localhost/api/webhooks/stripe", {
      method: "POST",
      body,
      headers: { "stripe-signature": header },
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
const cancel = (orderId: string, gateway: FakeStripeGateway, extra: object = {}) =>
  changeOrderStatus(actor, orderId, OrderStatus.CANCELLED, db, { gateway, ...extra });

describe("admin cancel of a linked, still-payable PaymentIntent", () => {
  it("cancels at the provider FIRST, releases stock only after confirmation, exactly once", async () => {
    const gateway = new FakeStripeGateway();
    const { v, order, piId } = await orderWithLinkedIntent(gateway);

    const result = await cancel(order.id, gateway);

    expect(result).toMatchObject({ from: "PENDING", to: "CANCELLED", inventoryEffect: "release" });
    expect((await gateway.retrievePaymentIntent(piId)).status).toBe("canceled"); // no payable intent left
    expect(await orderRow(order.id)).toMatchObject({ status: OrderStatus.CANCELLED });
    expect(await itemRow(v.inventoryItemId)).toMatchObject({ quantityOnHand: 10, quantityReserved: 0 });
    expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(1);
    expect((await db.payment.findUniqueOrThrow({ where: { orderId: order.id } })).status).toBe("FAILED");
  });

  it("the old unsafe path is structurally closed: releasing straight through the transition is refused while the payment is live", async () => {
    const gateway = new FakeStripeGateway();
    const { v, order, piId } = await orderWithLinkedIntent(gateway);

    await expect(applyOrderStatusTransition(actor, order.id, OrderStatus.CANCELLED, db)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect((await orderRow(order.id)).status).toBe(OrderStatus.PENDING);
    expect((await itemRow(v.inventoryItemId)).quantityReserved).toBe(1);
    expect((await gateway.retrievePaymentIntent(piId)).status).toBe("requires_payment_method"); // untouched
  });

  it("(race) payment succeeds between the admin's read and the provider seeing the cancel: NOT cancelled, reconciled as PAID, stock committed — never released against a charge", async () => {
    const gateway = new FakeStripeGateway();
    const { v, order, piId } = await orderWithLinkedIntent(gateway);
    gateway.onNextCancel((id) => gateway.patch(id, { status: "succeeded", amountReceived: 2330 }));

    const err = await cancel(order.id, gateway).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).publicMessage).toMatch(/NOT cancelled.*already succeeded/);
    expect(await orderRow(order.id)).toEqual({ status: "CONFIRMED", paymentStatus: "PAID" });
    expect(await itemRow(v.inventoryItemId)).toMatchObject({ quantityOnHand: 9, quantityReserved: 0 });
    expect(await movementCount(v.inventoryItemId, StockMovementType.SALE)).toBe(1);
    expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(0);
    expect((await gateway.retrievePaymentIntent(piId)).status).toBe("succeeded");
    expect(await db.auditLog.count({ where: { action: "order.cancel.preserved", entityId: order.id } })).toBe(1);
    // No late_success / refund-required state: the payment is a normal, paid order.
    expect(await db.auditLog.count({ where: { action: "payment.late_success", entityId: order.id } })).toBe(0);
  });

  it("payment already succeeded before the admin acts: same result (reconciled paid, not cancelled)", async () => {
    const gateway = new FakeStripeGateway();
    const { v, order, piId } = await orderWithLinkedIntent(gateway);
    gateway.patch(piId, { status: "succeeded", amountReceived: 2330 });

    await expect(cancel(order.id, gateway)).rejects.toMatchObject({ publicMessage: expect.stringMatching(/already succeeded/) });
    expect(await orderRow(order.id)).toEqual({ status: "CONFIRMED", paymentStatus: "PAID" });
    expect(gateway.cancelCallCount).toBe(0); // never even asked the provider to cancel a paid intent
    expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(0);
  });

  it("a processing payment is preserved untouched with a clear message", async () => {
    const gateway = new FakeStripeGateway();
    const { v, order, piId } = await orderWithLinkedIntent(gateway);
    gateway.patch(piId, { status: "processing" });

    await expect(cancel(order.id, gateway)).rejects.toMatchObject({
      publicMessage: expect.stringMatching(/processing at the provider/),
    });
    expect(await orderRow(order.id)).toMatchObject({ status: OrderStatus.PENDING, paymentStatus: PaymentStatus.UNPAID });
    expect((await itemRow(v.inventoryItemId)).quantityReserved).toBe(1);
    expect(gateway.cancelCallCount).toBe(0);
  });

  it("provider cancellation timeout: nothing released; retry succeeds and releases once", async () => {
    const gateway = new FakeStripeGateway();
    const { v, order, piId } = await orderWithLinkedIntent(gateway);
    gateway.scriptCancelFailure(piId, new PaymentGatewayError("Stripe: timed out", { ambiguous: true }));

    await expect(cancel(order.id, gateway)).rejects.toMatchObject({
      publicMessage: expect.stringMatching(/NOT cancelled.*unchanged/),
    });
    expect(await orderRow(order.id)).toMatchObject({ status: OrderStatus.PENDING });
    expect((await itemRow(v.inventoryItemId)).quantityReserved).toBe(1);
    expect((await gateway.retrievePaymentIntent(piId)).status).toBe("requires_payment_method");

    await cancel(order.id, gateway);
    expect(await orderRow(order.id)).toMatchObject({ status: OrderStatus.CANCELLED });
    expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(1);
  });

  it("uncertain cancel whose provider side DID apply (lost response): stock stays reserved until the next authoritative read, then released exactly once", async () => {
    const gateway = new FakeStripeGateway();
    const { v, order, piId } = await orderWithLinkedIntent(gateway);
    gateway.scriptCancelLostResponse(piId);

    await expect(cancel(order.id, gateway)).rejects.toBeInstanceOf(ConflictError);
    // Provider already canceled it, but we did not get to know: nothing released yet.
    expect((await gateway.retrievePaymentIntent(piId)).status).toBe("canceled");
    expect(await orderRow(order.id)).toMatchObject({ status: OrderStatus.PENDING });
    expect((await itemRow(v.inventoryItemId)).quantityReserved).toBe(1);

    await cancel(order.id, gateway); // retrieve now reports canceled → shared finalize
    expect(await orderRow(order.id)).toMatchObject({ status: OrderStatus.CANCELLED });
    expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(1);
    // A repeat admin click (or sweep) on the cancelled order never double-releases.
    await cancel(order.id, gateway).catch(() => undefined);
    await runOrderExpirySweep(db, gateway, IMMEDIATE);
    expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(1);
    expect((await itemRow(v.inventoryItemId)).quantityReserved).toBe(0);
  });

  it("concurrent admin cancel, sweep and webhook converge: one release, the intent canceled", async () => {
    const gateway = new FakeStripeGateway();
    const { v, order, piId } = await orderWithLinkedIntent(gateway);

    await Promise.allSettled([
      cancel(order.id, gateway),
      cancel(order.id, gateway),
      runOrderExpirySweep(db, gateway, IMMEDIATE),
    ]);
    await runOrderExpirySweep(db, gateway, IMMEDIATE);

    expect(await orderRow(order.id)).toMatchObject({ status: OrderStatus.CANCELLED });
    expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(1);
    expect((await itemRow(v.inventoryItemId)).quantityReserved).toBe(0);
    expect((await gateway.retrievePaymentIntent(piId)).status).toBe("canceled");
  });
});

describe("confirmed admin cancellation followed by duplicate or delayed webhooks", () => {
  it("delayed payment_intent.canceled, its duplicate, and a stale payment_intent.succeeded change nothing", async () => {
    const gateway = new FakeStripeGateway();
    const { v, order, piId } = await orderWithLinkedIntent(gateway);
    await cancel(order.id, gateway);
    const stock = await itemRow(v.inventoryItemId);
    expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(1);

    const canceledPi = await gateway.retrievePaymentIntent(piId);
    const evt = makeEvent("payment_intent.canceled", canceledPi);
    const first = await post(evt.body, evt.header);
    const dup = await post(evt.body, evt.header);
    expect(first.status).toBe(200);
    expect(dup.json).toMatchObject({ duplicate: true });

    // A stale "succeeded" event (delivered late / replayed): the webhook handler
    // re-fetches the authoritative intent (canceled), so nothing is committed.
    const stale = makeEvent("payment_intent.succeeded", { ...canceledPi, status: "succeeded" });
    const staleRes = await post(stale.body, stale.header);
    expect(staleRes.status).toBe(200);

    expect(await orderRow(order.id)).toMatchObject({ status: OrderStatus.CANCELLED, paymentStatus: PaymentStatus.FAILED });
    expect(await itemRow(v.inventoryItemId)).toEqual(stock);
    expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(1);
    expect(await movementCount(v.inventoryItemId, StockMovementType.SALE)).toBe(0);
  });
});

describe("legacy (pre-claim) orders and an unconfigured rollout boundary — a search miss never authorizes release", () => {
  const FUTURE = new Date(Date.now() + 3_600_000); // every order created now predates it → legacy
  const PAST = new Date(Date.now() - 86_400_000); // claims already live → order is post-claim

  it("an eventually-consistent search miss with a real hidden intent: sweep preserves and flags, repeatedly; admin cancel refuses", async () => {
    const gateway = new FakeStripeGateway();
    __setPaymentGateway(gateway);
    const { v, order } = await pendingOrder(10, 1);
    // A historical attempt created this intent; no local Payment row exists (pre-claim crash).
    const hidden = gateway.createIntentFor(order.id, order.orderNumber, 2330);
    gateway.searchMisses = true;
    expect(await db.payment.findUnique({ where: { orderId: order.id } })).toBeNull();

    const policy: ExpiryPolicy = { ...IMMEDIATE, claimsActiveSince: FUTURE };
    for (let i = 0; i < 2; i++) {
      const sweep = await runOrderExpirySweep(db, gateway, policy);
      expect(sweep.items).toContainEqual(
        expect.objectContaining({ orderId: order.id, outcome: "preserved_legacy_needs_review" }),
      );
    }
    await expect(
      cancelPendingOrder(actor, order.id, { db, gateway, claimsActiveSince: FUTURE }),
    ).rejects.toThrow(/predates durable payment tracking.*Manual reconciliation is required/);

    expect(await orderRow(order.id)).toMatchObject({ status: OrderStatus.PENDING, paymentStatus: PaymentStatus.UNPAID });
    expect((await itemRow(v.inventoryItemId)).quantityReserved).toBe(1);
    expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(0);
    expect((await gateway.retrievePaymentIntent(hidden.id)).status).toBe("requires_payment_method");
    expect(gateway.cancelCallCount).toBe(0);

    // Search catches up: the SAME sweep now finds it, backfills the row, and
    // gives it the full provider-confirmed cancellation treatment.
    gateway.searchMisses = false;
    const later = await runOrderExpirySweep(db, gateway, policy);
    expect(later.items).toContainEqual(
      expect.objectContaining({ orderId: order.id, outcome: "cancelled_provider_confirmed" }),
    );
    expect((await gateway.retrievePaymentIntent(hidden.id)).status).toBe("canceled");
    expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(1);
  });

  it("a hidden intent that already SUCCEEDED is never released against: once visible it reconciles as paid", async () => {
    const gateway = new FakeStripeGateway();
    __setPaymentGateway(gateway);
    const { v, order } = await pendingOrder(10, 1);
    gateway.createIntentFor(order.id, order.orderNumber, 2330, "succeeded");
    gateway.searchMisses = true;
    const policy: ExpiryPolicy = { ...IMMEDIATE, claimsActiveSince: FUTURE };

    await runOrderExpirySweep(db, gateway, policy);
    expect((await itemRow(v.inventoryItemId)).quantityReserved).toBe(1);

    gateway.searchMisses = false;
    await runOrderExpirySweep(db, gateway, policy);
    expect(await orderRow(order.id)).toEqual({ status: "CONFIRMED", paymentStatus: "PAID" });
    expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(0);
  });

  it("NO override exists: attempting to attest absence (a removed option, passed anyway) cannot release a legacy order's stock", async () => {
    const gateway = new FakeStripeGateway();
    __setPaymentGateway(gateway);
    const { v, order } = await pendingOrder(10, 1);
    gateway.createIntentFor(order.id, order.orderNumber, 2330); // a hidden historical payment
    gateway.searchMisses = true;

    await expect(
      cancelPendingOrder(actor, order.id, {
        db,
        gateway,
        claimsActiveSince: FUTURE,
        legacyAbsenceVerified: true,
      } as never),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      changeOrderStatus(actor, order.id, OrderStatus.CANCELLED, db, {
        gateway,
        claimsActiveSince: FUTURE,
        legacyAbsenceVerified: true,
      } as never),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(await orderRow(order.id)).toMatchObject({ status: OrderStatus.PENDING });
    expect((await itemRow(v.inventoryItemId)).quantityReserved).toBe(1);
    expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(0);
    expect(await db.auditLog.count({ where: { action: "order.cancel.preserved", entityId: order.id } })).toBe(2);
  });

  it("attempted override of an AMBIGUOUS payment state (unresolved claim + search miss) is refused by the shared guard", async () => {
    const gateway = new FakeStripeGateway();
    __setPaymentGateway(gateway);
    const { v, order } = await pendingOrder(10, 1);
    gateway.searchMisses = true;
    await db.payment.create({
      data: {
        orderId: order.id,
        provider: "stripe",
        providerPaymentId: null,
        status: "PENDING",
        amountCents: 2330,
        currency: "CAD",
      },
    });

    await expect(
      changeOrderStatus(actor, order.id, OrderStatus.CANCELLED, db, {
        gateway,
        claimsActiveSince: PAST,
        legacyAbsenceVerified: true,
      } as never),
    ).rejects.toThrow(/payment attempt in progress/);
    expect(await orderRow(order.id)).toMatchObject({ status: OrderStatus.PENDING });
    expect((await itemRow(v.inventoryItemId)).quantityReserved).toBe(1);
    expect(gateway.cancelCallCount).toBe(0);
  });

  it("UNCONFIGURED boundary fails closed: no-row order + search miss is preserved by the sweep (repeatedly) and by admin cancel", async () => {
    const gateway = new FakeStripeGateway();
    __setPaymentGateway(gateway);
    const { v, order } = await pendingOrder(10, 1);
    gateway.searchMisses = true;

    // Default policy shape: the boundary is simply not provided.
    for (let i = 0; i < 2; i++) {
      const sweep = await runOrderExpirySweep(db, gateway, { minAgeMs: -60_000 });
      expect(sweep.items).toContainEqual(
        expect.objectContaining({ orderId: order.id, outcome: "preserved_claims_cutoff_unconfigured" }),
      );
    }
    await expect(
      cancelPendingOrder(actor, order.id, { db, gateway, claimsActiveSince: null }),
    ).rejects.toThrow(/PAYMENT_CLAIMS_ACTIVE_SINCE is not configured.*Configuration and manual reconciliation are required/);

    expect(await orderRow(order.id)).toMatchObject({ status: OrderStatus.PENDING, paymentStatus: PaymentStatus.UNPAID });
    expect((await itemRow(v.inventoryItemId)).quantityReserved).toBe(1);
    expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(0);
  });

  it("UNCONFIGURED boundary still reconciles where authoritative evidence exists: linked payment, and a search hit", async () => {
    const gateway = new FakeStripeGateway();
    // (a) linked PaymentIntent — admin cancel and sweep both work without the boundary.
    const linked = await orderWithLinkedIntent(gateway);
    await changeOrderStatus(actor, linked.order.id, OrderStatus.CANCELLED, db, { gateway, claimsActiveSince: null });
    expect(await orderRow(linked.order.id)).toMatchObject({ status: OrderStatus.CANCELLED });
    expect((await gateway.retrievePaymentIntent(linked.piId)).status).toBe("canceled");

    const second = await orderWithLinkedIntent(gateway);
    gateway.patch(second.piId, { status: "succeeded", amountReceived: 2330 });
    const sweep = await runOrderExpirySweep(db, gateway, { minAgeMs: -60_000 });
    expect(sweep.items).toContainEqual(expect.objectContaining({ orderId: second.order.id, outcome: "finalized_paid" }));

    // (b) a search HIT on a no-row order — adopted and reconciled.
    const { v, order } = await pendingOrder(10, 1);
    const hit = gateway.createIntentFor(order.id, order.orderNumber, 2330);
    const sweep2 = await runOrderExpirySweep(db, gateway, { minAgeMs: -60_000 });
    expect(sweep2.items).toContainEqual(
      expect.objectContaining({ orderId: order.id, outcome: "cancelled_provider_confirmed" }),
    );
    expect((await gateway.retrievePaymentIntent(hit.id)).status).toBe("canceled");
    expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(1);
  });

  it("a POST-claim order with no row and a search miss is provably never-attempted: cancels automatically", async () => {
    const gateway = new FakeStripeGateway();
    __setPaymentGateway(gateway);
    const { v, order } = await pendingOrder(10, 1);
    gateway.searchMisses = true;

    const sweep = await runOrderExpirySweep(db, gateway, { ...IMMEDIATE, claimsActiveSince: PAST });
    expect(sweep.items).toContainEqual(
      expect.objectContaining({ orderId: order.id, outcome: "cancelled_no_payment_intent" }),
    );
    expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(1);
  });

  it("after an admin cancel wins, startPayment cannot start a payment against the released stock (zero provider calls)", async () => {
    const gateway = new FakeStripeGateway();
    __setPaymentGateway(gateway);
    const { order } = await pendingOrder(10, 1);
    await cancelPendingOrder(actor, order.id, { db, gateway, claimsActiveSince: PAST });

    await expect(startPayment(order.orderNumber, { justPlaced: true }, {}, db, gateway)).rejects.toThrow(
      /can no longer be paid/,
    );
    expect(gateway.createCallCount).toBe(0);
  });
});
