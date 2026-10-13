import { OrderStatus, PaymentStatus, PaymentTransactionStatus, StockMovementType } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { addToCart } from "@/server/cart/cart-service";
import { placeOrder } from "@/server/orders/checkout-service";
import {
  CLAIM_INFLIGHT_WINDOW_MS,
  IDEMPOTENT_RECOVERY_MAX_AGE_MS,
  startPayment,
  createOrRecoverPaymentIntent,
} from "@/server/orders/payment-service";
import { applyOrderStatusTransitionTx } from "@/server/orders/order-inventory";
import { runOrderExpirySweep, type ExpiryPolicy } from "@/server/orders/order-expiry";
import { PaymentGatewayError } from "@/server/domain/payments";
import { ConflictError } from "@/server/catalog/errors";
import { cleanup, db, makeVariant } from "./helpers/db";
import {
  cleanupCheckout,
  ensureTaxAndShippingConfig,
  makeCart,
  placeOrderInput,
  type TestShippingConfig,
} from "./helpers/checkout";
import { FakeStripeGateway } from "./helpers/payments";

/**
 * Abandoned-checkout reservation recovery (launch-prep milestone).
 *
 * `minAgeMs: 0` is used throughout instead of backdating `createdAt` —
 * `runOrderExpirySweep`'s own age floor is a policy PARAMETER precisely so
 * tests can exercise "this order is eligible" without needing real wall-clock
 * age; the floor itself (`ORDER_EXPIRY_MINUTES`, defaulted from env) is not
 * what these tests are about.
 *
 * Every scenario uses a real order created through the real `placeOrder`
 * checkout flow (never a hand-built `Order` row) and a real `FakeStripeGateway`
 * (never a mock of this module's own logic) — proving the actual
 * reserve/commit/release inventory effects, not simulated ones.
 */

let cfg: TestShippingConfig;
// A negative `minAgeMs` (cutoff computed 60s into the FUTURE) rather than
// exactly 0 — `Order.createdAt` is set by POSTGRES's own `now()`
// (`@default(now())`), while the cutoff here is computed from NODE's
// `Date.now()`; a `minAgeMs: 0` cutoff is one bad clock-skew moment away
// from excluding an order created a few milliseconds ago (observed: this
// made the concurrency test below genuinely flaky under full-suite timing,
// not just in theory). A 60-second margin absorbs any realistic skew
// between the two processes without weakening what these tests are
// actually about.
// `claimsActiveSince` is explicit: an UNCONFIGURED boundary fails closed (see
// admin-cancel.integration.test.ts), so a test that expects a "never attempted"
// order to be cancelled states that every order here is post-claim.
const IMMEDIATE: ExpiryPolicy = { minAgeMs: -60_000, claimsActiveSince: new Date("2000-01-01T00:00:00Z") };

beforeAll(async () => {
  cfg = await ensureTaxAndShippingConfig();
});
afterEach(async () => {
  await cleanupCheckout();
  await cleanup();
});
afterAll(async () => {
  await db.$disconnect();
});

async function pendingOrder(onHand: number, qty: number) {
  const v = await makeVariant({ onHand });
  const cart = await makeCart();
  await addToCart({ token: cart.token }, { variantId: v.variantId, quantity: qty });
  const order = await placeOrder({ token: cart.token }, placeOrderInput(cfg.shippingMethodId));
  return { v, order };
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

describe("runOrderExpirySweep — no PaymentIntent at all (genuinely never attempted)", () => {
  it("cancels the order directly and releases the reservation — no gateway call needed beyond the metadata search", async () => {
    const gateway = new FakeStripeGateway();
    const { v, order } = await pendingOrder(10, 3);

    const result = await runOrderExpirySweep(db, gateway, IMMEDIATE);

    expect(result.items).toContainEqual(
      expect.objectContaining({ orderId: order.id, outcome: "cancelled_no_payment_intent" }),
    );
    const fresh = await orderRow(order.id);
    expect(fresh).toMatchObject({ status: OrderStatus.CANCELLED, paymentStatus: PaymentStatus.UNPAID });
    const item = await itemRow(v.inventoryItemId);
    expect(item).toMatchObject({ quantityOnHand: 10, quantityReserved: 0 }); // released, not sold
    expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(1);

    const audit = await db.auditLog.findFirst({ where: { action: "order.expired", entityId: order.id } });
    expect(audit).not.toBeNull();
  });

  it("never touches a PAID order, or one that already left PENDING — excluded by the query itself", async () => {
    const gateway = new FakeStripeGateway();
    const { order } = await pendingOrder(5, 1);
    await db.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.CONFIRMED, paymentStatus: PaymentStatus.PAID },
    });

    const result = await runOrderExpirySweep(db, gateway, IMMEDIATE);

    expect(result.items.find((i) => i.orderId === order.id)).toBeUndefined();
    const fresh = await orderRow(order.id);
    expect(fresh).toMatchObject({ status: OrderStatus.CONFIRMED, paymentStatus: PaymentStatus.PAID });
  });
});

describe("runOrderExpirySweep — the no-PaymentIntent race: absence of a stored id is not proof nothing exists at the provider", () => {
  it("finds an orphaned, already-succeeded PaymentIntent and reconciles it as PAID — never cancels it", async () => {
    const gateway = new FakeStripeGateway();
    const { v, order } = await pendingOrder(10, 2);
    // Simulate `startPayment`'s own race: a real PaymentIntent exists at the
    // provider (created here directly on the fake, bypassing `startPayment`
    // entirely) but no local `Payment` row was ever written for it.
    // 2 * $10 + $12 flat shipping + 13% HST on the $20 subtotal = $34.60 —
    // must match the order's own frozen total exactly, or
    // `finalizeFromPaymentIntentTx`'s amount/currency guard (correctly)
    // refuses to reconcile it.
    const orphan = gateway.createIntentFor(order.id, order.orderNumber, 3460, "succeeded");
    expect(await db.payment.findUnique({ where: { orderId: order.id } })).toBeNull();

    const result = await runOrderExpirySweep(db, gateway, IMMEDIATE);

    expect(result.items).toContainEqual(
      expect.objectContaining({ orderId: order.id, outcome: "finalized_paid" }),
    );
    const fresh = await orderRow(order.id);
    expect(fresh).toMatchObject({ status: OrderStatus.CONFIRMED, paymentStatus: PaymentStatus.PAID });
    // Backfilled, not left orphaned — a real Payment record now exists.
    const payment = await db.payment.findUnique({ where: { orderId: order.id } });
    expect(payment).toMatchObject({ providerPaymentId: orphan.id });
    // Committed (sold), not released.
    const item = await itemRow(v.inventoryItemId);
    expect(item).toMatchObject({ quantityOnHand: 8, quantityReserved: 0 });
    expect(await movementCount(v.inventoryItemId, StockMovementType.SALE)).toBe(1);
    expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(0);
  });

  it("finds an orphaned, still-payable PaymentIntent, backfills it, and gives it the full confirmed-cancellation treatment", async () => {
    const gateway = new FakeStripeGateway();
    const { v, order } = await pendingOrder(10, 1);
    // 1 * $10 + $12 flat shipping + 13% HST on the $10 subtotal = $23.30.
    gateway.createIntentFor(order.id, order.orderNumber, 2330, "requires_payment_method");

    const result = await runOrderExpirySweep(db, gateway, IMMEDIATE);

    expect(result.items).toContainEqual(
      expect.objectContaining({ orderId: order.id, outcome: "cancelled_provider_confirmed" }),
    );
    const fresh = await orderRow(order.id);
    expect(fresh.status).toBe(OrderStatus.CANCELLED);
    const item = await itemRow(v.inventoryItemId);
    expect(item.quantityReserved).toBe(0);
  });
});

describe("durable payment-creation claim — the coordination mechanism itself, not a timing-based re-check", () => {
  it("expiry winning first: once an order is cancelled, startPayment refuses before ever calling the provider", async () => {
    const gateway = new FakeStripeGateway();
    const { v, order } = await pendingOrder(10, 1);

    const sweepResult = await runOrderExpirySweep(db, gateway, IMMEDIATE);
    expect(sweepResult.items).toContainEqual(
      expect.objectContaining({ orderId: order.id, outcome: "cancelled_no_payment_intent" }),
    );
    expect((await orderRow(order.id)).status).toBe(OrderStatus.CANCELLED);

    // The order is now CANCELLED. A `startPayment` call arriving after the
    // fact — its own claim transaction acquires the Order row lock, re-reads
    // the CURRENT (cancelled) state, and refuses — never reaching
    // `createPaymentIntent` at all.
    await expect(startPayment(order.orderNumber, { justPlaced: true }, {}, db, gateway)).rejects.toMatchObject(
      { message: "This order can no longer be paid." },
    );
    expect(await db.payment.findUnique({ where: { orderId: order.id } })).toBeNull();
    const item = await itemRow(v.inventoryItemId);
    expect(item.quantityReserved).toBe(0); // unchanged — no payment attempt ever reached the provider
  });

  it("creation winning first: a payment claim that resolves before the sweep's cancellation transaction commits is preserved, not cancelled out from under it", async () => {
    const gateway = new FakeStripeGateway();
    const { v, order } = await pendingOrder(10, 1);
    expect(await db.payment.findUnique({ where: { orderId: order.id } })).toBeNull();
    expect(await gateway.findPaymentIntentForOrder(order.id)).toBeNull();

    // Deterministically interjects the REAL `startPayment` at the exact
    // point `cancelDirectly` is about to open its own cancellation
    // transaction — strictly after the sweep's EARLIER, now-stale checks
    // found nothing, strictly before its transaction (re-)acquires the
    // Order row lock. This is the precise ordering named in the brief:
    // sweep sees no intent -> payment creation resumes -> cancellation
    // competes with that creation.
    const sweepResult = await runOrderExpirySweep(db, gateway, IMMEDIATE, {
      beforeCancelDirectly: async (orderId) => {
        expect(orderId).toBe(order.id);
        const result = await startPayment(order.orderNumber, { justPlaced: true }, {}, db, gateway);
        expect(result.alreadyPaid).toBe(false);
        expect(result.clientSecret).not.toBe("");
      },
    });

    expect(sweepResult.items).toContainEqual(
      expect.objectContaining({ orderId: order.id, outcome: "preserved_payment_started" }),
    );
    const afterRace = await orderRow(order.id);
    expect(afterRace).toMatchObject({ status: OrderStatus.PENDING, paymentStatus: PaymentStatus.UNPAID });
    const itemAfterRace = await itemRow(v.inventoryItemId);
    expect(itemAfterRace.quantityReserved).toBe(1); // intact — never released against a payment that now exists
    const payment = await db.payment.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(payment.providerPaymentId).toBeTruthy(); // resolved, not a dangling fiction

    // A later sweep (once the customer completes or truly abandons again)
    // reconciles this exactly like any other linked payment — the
    // preserved state is not a dead end.
    const laterSweep = await runOrderExpirySweep(db, gateway, IMMEDIATE);
    expect(laterSweep.items).toContainEqual(
      expect.objectContaining({ orderId: order.id, outcome: "cancelled_provider_confirmed" }),
    );
    expect((await orderRow(order.id)).status).toBe(OrderStatus.CANCELLED);
  });

  it("the claim itself blocks a direct cancellation attempt while unresolved — proving the lock-based coordination, not merely its outcome", async () => {
    const gateway = new FakeStripeGateway();
    const { order } = await pendingOrder(10, 1);

    // A real cancellation attempt (the same primitive both the expiry
    // sweep and the admin "Cancel" action use) landing in the exact window
    // between the claim committing and the provider resolving it must be
    // REFUSED — not silently skipped, not racing to an inconsistent
    // result.
    await expect(
      startPayment(order.orderNumber, { justPlaced: true }, {}, db, gateway, {
        afterClaimCommitted: async () => {
          const payment = await db.payment.findUniqueOrThrow({ where: { orderId: order.id } });
          expect(payment.providerPaymentId).toBeNull(); // genuinely unresolved at this instant
          await expect(
            db.$transaction((tx) => applyOrderStatusTransitionTx(tx, order.id, OrderStatus.CANCELLED)),
          ).rejects.toBeInstanceOf(ConflictError);
        },
      }),
    ).resolves.toMatchObject({ alreadyPaid: false });

    // startPayment itself completed normally — the blocked cancellation
    // attempt didn't corrupt its own claim.
    const payment = await db.payment.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(payment.providerPaymentId).toBeTruthy();
    expect((await orderRow(order.id)).status).toBe(OrderStatus.PENDING);
  });
});

describe("interruption after provider success but before local persistence — recovered by a later sweep via the same stable idempotency key", () => {
  /** Mirrors exactly what startPayment's own claim step writes, without ever calling the provider — simulating the crash window. */
  async function leaveUnresolvedClaim(
    orderId: string,
    ageMs: number = CLAIM_INFLIGHT_WINDOW_MS + 60_000,
  ): Promise<void> {
    const order = await db.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { totalCents: true, currency: true },
    });
    await db.payment.create({
      data: {
        orderId,
        provider: "stripe",
        providerPaymentId: null,
        status: PaymentTransactionStatus.PENDING,
        amountCents: order.totalCents,
        currency: order.currency,
        createdAt: new Date(Date.now() - ageMs),
      },
    });
  }

  it("the provider actually succeeded before the crash — recovered and finalized as paid, never released", async () => {
    const gateway = new FakeStripeGateway();
    const { v, order } = await pendingOrder(10, 2);

    // The "crash": the real provider call that `startPayment` would have
    // made already happened (via the SAME stable idempotency key this
    // order would use) and genuinely succeeded — but the process died
    // before `db.payment.update` could persist the resulting id, leaving
    // only the claim row behind.
    const realPi = await createOrRecoverPaymentIntent(gateway, {
      orderId: order.id,
      orderNumber: order.orderNumber,
      amountCents: 3460, // 2 * $10 + $12 shipping + 13% HST on $20
      currency: "cad",
      receiptEmail: "buyer.phase6@taek.local",
    });
    gateway.patch(realPi.id, { status: "succeeded" });
    await leaveUnresolvedClaim(order.id);
    // Confirmed starting state: exactly what a real crash leaves behind —
    // no local record of the id, even though the provider has a real,
    // already-succeeded intent for this exact order.
    expect((await db.payment.findUniqueOrThrow({ where: { orderId: order.id } })).providerPaymentId).toBeNull();

    const result = await runOrderExpirySweep(db, gateway, IMMEDIATE);

    expect(result.items).toContainEqual(
      expect.objectContaining({ orderId: order.id, outcome: "finalized_paid" }),
    );
    const fresh = await orderRow(order.id);
    expect(fresh).toMatchObject({ status: OrderStatus.CONFIRMED, paymentStatus: PaymentStatus.PAID });
    const payment = await db.payment.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(payment.providerPaymentId).toBe(realPi.id); // recovered via the SAME idempotency key, not a new intent
    // The invariant this whole milestone exists to prove: stock was
    // COMMITTED (sold), never released, against a payment that was in fact
    // successful.
    const item = await itemRow(v.inventoryItemId);
    expect(item).toMatchObject({ quantityOnHand: 8, quantityReserved: 0 });
    expect(await movementCount(v.inventoryItemId, StockMovementType.SALE)).toBe(1);
    expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(0);
  });

  it("the provider call never actually reached Stripe before the crash — recovery creates a genuinely fresh intent via the same idempotency key, then resolves it normally", async () => {
    const gateway = new FakeStripeGateway();
    const { v, order } = await pendingOrder(10, 1);

    // The "crash": the claim was written, but the process died BEFORE ever
    // calling the provider at all — no PaymentIntent exists anywhere yet,
    // unlike the test above.
    await leaveUnresolvedClaim(order.id);
    expect(await gateway.findPaymentIntentForOrder(order.id)).toBeNull();

    const result = await runOrderExpirySweep(db, gateway, IMMEDIATE);

    // Recovery created a real, fresh PaymentIntent (still payable — a
    // brand-new intent has no reason to already be settled) and gave it
    // the full confirmed-cancellation treatment, same as any other
    // still-payable linked payment.
    expect(result.items).toContainEqual(
      expect.objectContaining({ orderId: order.id, outcome: "cancelled_provider_confirmed" }),
    );
    const fresh = await orderRow(order.id);
    expect(fresh.status).toBe(OrderStatus.CANCELLED);
    const item = await itemRow(v.inventoryItemId);
    expect(item.quantityReserved).toBe(0);
    const payment = await db.payment.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(payment.providerPaymentId).toBeTruthy();
    const pi = await gateway.retrievePaymentIntent(payment.providerPaymentId!);
    expect(pi.status).toBe("canceled"); // confirmed cancelled, never left payable
  });

  it("a failed/uncertain compensating cancellation during claim recovery preserves the reservation — retried safely on a later sweep", async () => {
    const gateway = new FakeStripeGateway();
    const { v, order } = await pendingOrder(10, 1);

    const realPi = await createOrRecoverPaymentIntent(gateway, {
      orderId: order.id,
      orderNumber: order.orderNumber,
      amountCents: 2330, // 1 * $10 + $12 shipping + 13% HST on $10
      currency: "cad",
      receiptEmail: "buyer.phase6@taek.local",
    });
    // Still payable — recovery will attempt to actively cancel it.
    await leaveUnresolvedClaim(order.id);
    gateway.scriptCancelFailure(
      realPi.id,
      new PaymentGatewayError("Stripe: connection timed out", { ambiguous: true }),
    );

    const first = await runOrderExpirySweep(db, gateway, IMMEDIATE);
    expect(first.items).toContainEqual(
      expect.objectContaining({ orderId: order.id, outcome: "preserved_ambiguous" }),
    );
    const afterFirst = await orderRow(order.id);
    expect(afterFirst).toMatchObject({ status: OrderStatus.PENDING, paymentStatus: PaymentStatus.UNPAID });
    const itemAfterFirst = await itemRow(v.inventoryItemId);
    expect(itemAfterFirst.quantityReserved).toBe(1); // preserved — no payable/successful payment is left against released stock, because nothing was released
    // The claim is now resolved (recovery updates the local row with the
    // real id even though the cancel attempt itself failed) — reflecting
    // the real, current state rather than leaving it stale.
    expect((await db.payment.findUniqueOrThrow({ where: { orderId: order.id } })).providerPaymentId).toBe(
      realPi.id,
    );

    // Retried safely on a later sweep — the scripted failure was one-shot.
    const second = await runOrderExpirySweep(db, gateway, IMMEDIATE);
    expect(second.items).toContainEqual(
      expect.objectContaining({ orderId: order.id, outcome: "cancelled_provider_confirmed" }),
    );
    const afterSecond = await orderRow(order.id);
    expect(afterSecond.status).toBe(OrderStatus.CANCELLED);
    const itemAfterSecond = await itemRow(v.inventoryItemId);
    expect(itemAfterSecond.quantityReserved).toBe(0);
  });
});

describe("unresolved-claim recovery policy — age bands, stale idempotent replays, retention limits", () => {
  const OLD = IDEMPOTENT_RECOVERY_MAX_AGE_MS + 60_000;
  const YOUNG = 30_000;
  const IN_WINDOW = CLAIM_INFLIGHT_WINDOW_MS + 60_000;

  async function claim(orderId: string, ageMs: number): Promise<void> {
    const order = await db.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { totalCents: true, currency: true },
    });
    await db.payment.create({
      data: {
        orderId,
        provider: "stripe",
        providerPaymentId: null,
        status: PaymentTransactionStatus.PENDING,
        amountCents: order.totalCents,
        currency: order.currency,
        createdAt: new Date(Date.now() - ageMs),
      },
    });
  }
  const orderInput = (order: { id: string; orderNumber: string }, amountCents: number) => ({
    orderId: order.id,
    orderNumber: order.orderNumber,
    amountCents,
    currency: "cad",
    receiptEmail: "buyer.phase6@taek.local",
  });

  it("(1) provider success, then execution stops before local persistence: a REAL startPayment leaves a durable claim; stock stays reserved until recovery reconciles it", async () => {
    const gateway = new FakeStripeGateway();
    const { v, order } = await pendingOrder(10, 1);

    // The real startPayment path: the provider creates the intent but the
    // caller never learns of it (response lost) — an ambiguous failure.
    gateway.scriptCreate("lose_response");
    await expect(startPayment(order.orderNumber, { justPlaced: true }, {}, db, gateway)).rejects.toBeInstanceOf(
      PaymentGatewayError,
    );
    expect(gateway.intentCountFor(order.id)).toBe(1); // the provider DID create it
    const left = await db.payment.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(left.providerPaymentId).toBeNull(); // only the durable claim records it locally

    // Young claim: the sweep neither cancels, creates, nor releases anything.
    const young = await runOrderExpirySweep(db, gateway, IMMEDIATE);
    expect(young.items).toContainEqual(
      expect.objectContaining({ orderId: order.id, outcome: "preserved_claim_in_flight" }),
    );
    expect((await itemRow(v.inventoryItemId)).quantityReserved).toBe(1);
    expect(gateway.createCallCount).toBe(1);

    // Time passes; the customer paid via the lost-response intent meanwhile.
    await db.payment.update({
      where: { orderId: order.id },
      data: { createdAt: new Date(Date.now() - IN_WINDOW) },
    });
    const intentId = (await gateway.findPaymentIntentForOrder(order.id))!.id;
    gateway.patch(intentId, { status: "succeeded", amountReceived: 2330 });

    const result = await runOrderExpirySweep(db, gateway, IMMEDIATE);
    expect(result.items).toContainEqual(expect.objectContaining({ orderId: order.id, outcome: "finalized_paid" }));
    expect(gateway.intentCountFor(order.id)).toBe(1); // replay, never a duplicate
    const payment = await db.payment.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(payment.providerPaymentId).toBe(intentId);
    expect(await orderRow(order.id)).toMatchObject({
      status: OrderStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
    });
    expect(await itemRow(v.inventoryItemId)).toMatchObject({ quantityOnHand: 9, quantityReserved: 0 });
    expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(0);
  });

  it("a replayed idempotent create returns the ORIGINAL (stale) body — recovery decides from a fresh retrieve, so a payment that succeeded since is never cancelled", async () => {
    const gateway = new FakeStripeGateway();
    const { v, order } = await pendingOrder(10, 1);
    const first = await createOrRecoverPaymentIntent(gateway, orderInput(order, 2330));
    expect(first.status).toBe("requires_payment_method");
    gateway.patch(first.id, { status: "succeeded", amountReceived: 2330 });
    await claim(order.id, IN_WINDOW);

    // Prove the replay really IS stale in this fake, i.e. the test is meaningful.
    expect((await createOrRecoverPaymentIntent(gateway, orderInput(order, 2330))).status).toBe(
      "requires_payment_method",
    );

    const result = await runOrderExpirySweep(db, gateway, IMMEDIATE);
    expect(result.items).toContainEqual(expect.objectContaining({ orderId: order.id, outcome: "finalized_paid" }));
    expect((await gateway.retrievePaymentIntent(first.id)).status).toBe("succeeded"); // never cancelled
    expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(0);
  });

  it("an OLD claim (beyond idempotency retention) is NEVER re-issued: a search hit is adopted after a fresh retrieve", async () => {
    const gateway = new FakeStripeGateway();
    const { v, order } = await pendingOrder(10, 1);
    const pi = gateway.createIntentFor(order.id, order.orderNumber, 2330, "succeeded");
    await claim(order.id, OLD);

    const result = await runOrderExpirySweep(db, gateway, IMMEDIATE);
    expect(result.items).toContainEqual(expect.objectContaining({ orderId: order.id, outcome: "finalized_paid" }));
    expect(gateway.createCallCount).toBe(0); // no re-issue
    expect((await db.payment.findUniqueOrThrow({ where: { orderId: order.id } })).providerPaymentId).toBe(pi.id);
    expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(0);
  });

  it("an OLD claim with a search MISS is not proof of absence: nothing is created, cancelled or released; it is surfaced for manual recovery, and a pruned key cannot mint a duplicate", async () => {
    const gateway = new FakeStripeGateway();
    const { v, order } = await pendingOrder(10, 1);
    // A real intent exists, its key has been pruned by the provider, and
    // search is lagging — the worst case for this recovery.
    const hidden = await createOrRecoverPaymentIntent(gateway, orderInput(order, 2330));
    gateway.patch(hidden.id, { status: "succeeded", amountReceived: 2330 });
    gateway.pruneIdempotencyKeys();
    gateway.searchMisses = true;
    await claim(order.id, OLD);
    const createsBefore = gateway.createCallCount;

    for (let i = 0; i < 2; i++) {
      const result = await runOrderExpirySweep(db, gateway, IMMEDIATE);
      expect(result.items).toContainEqual(
        expect.objectContaining({ orderId: order.id, outcome: "preserved_claim_needs_review" }),
      );
    }
    expect(gateway.createCallCount).toBe(createsBefore); // never re-issued
    expect(gateway.intentCountFor(order.id)).toBe(1); // no duplicate minted
    expect(await orderRow(order.id)).toMatchObject({
      status: OrderStatus.PENDING,
      paymentStatus: PaymentStatus.UNPAID,
    });
    expect((await itemRow(v.inventoryItemId)).quantityReserved).toBe(1);

    // Customer-facing path also fails closed: no provider call, no client secret.
    await expect(startPayment(order.orderNumber, { justPlaced: true }, {}, db, gateway)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(gateway.createCallCount).toBe(createsBefore);

    // Operator recovery (the documented runbook): link the provider id found
    // via the Dashboard, then the normal sweep reconciles it.
    await db.payment.update({ where: { orderId: order.id }, data: { providerPaymentId: hidden.id } });
    const recovered = await runOrderExpirySweep(db, gateway, IMMEDIATE);
    expect(recovered.items).toContainEqual(
      expect.objectContaining({ orderId: order.id, outcome: "finalized_paid" }),
    );
    expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(0);
  });

  it("(4) uncertain creation during recovery (409 key-in-use / timeout) preserves everything; the retry after it clears resolves", async () => {
    const gateway = new FakeStripeGateway();
    const { v, order } = await pendingOrder(10, 1);
    await claim(order.id, IN_WINDOW);
    gateway.scriptCreate(new PaymentGatewayError("Stripe: idempotency_key_in_use", { ambiguous: true }));

    const first = await runOrderExpirySweep(db, gateway, IMMEDIATE);
    expect(first.items).toContainEqual(
      expect.objectContaining({ orderId: order.id, outcome: "preserved_ambiguous" }),
    );
    expect(await orderRow(order.id)).toMatchObject({
      status: OrderStatus.PENDING,
      paymentStatus: PaymentStatus.UNPAID,
    });
    expect((await itemRow(v.inventoryItemId)).quantityReserved).toBe(1);
    expect((await db.payment.findUniqueOrThrow({ where: { orderId: order.id } })).providerPaymentId).toBeNull();

    const second = await runOrderExpirySweep(db, gateway, IMMEDIATE);
    expect(second.items).toContainEqual(
      expect.objectContaining({ orderId: order.id, outcome: "cancelled_provider_confirmed" }),
    );
    expect((await itemRow(v.inventoryItemId)).quantityReserved).toBe(0);
    const payment = await db.payment.findUniqueOrThrow({ where: { orderId: order.id } });
    expect((await gateway.retrievePaymentIntent(payment.providerPaymentId!)).status).toBe("canceled");
  });

  it("startPayment recovers its own in-window unresolved claim through the same key (no duplicate), and the customer gets a usable client secret", async () => {
    const gateway = new FakeStripeGateway();
    const { order } = await pendingOrder(10, 1);
    gateway.scriptCreate("lose_response");
    await expect(startPayment(order.orderNumber, { justPlaced: true }, {}, db, gateway)).rejects.toBeInstanceOf(
      PaymentGatewayError,
    );

    const retry = await startPayment(order.orderNumber, { justPlaced: true }, {}, db, gateway);
    expect(retry.alreadyPaid).toBe(false);
    expect(retry.clientSecret).not.toBe("");
    expect(gateway.intentCountFor(order.id)).toBe(1);
    expect((await db.payment.findUniqueOrThrow({ where: { orderId: order.id } })).providerPaymentId).toBeTruthy();
  });

  it("(5) concurrent and repeated recovery: stock is released exactly once and no payable payment remains against released stock", async () => {
    const gateway = new FakeStripeGateway();
    const { v, order } = await pendingOrder(10, 1);
    await claim(order.id, IN_WINDOW);

    const runs = await Promise.all([
      runOrderExpirySweep(db, gateway, IMMEDIATE),
      runOrderExpirySweep(db, gateway, IMMEDIATE),
      runOrderExpirySweep(db, gateway, IMMEDIATE),
    ]);
    for (const run of runs) {
      for (const item of run.items.filter((i) => i.orderId === order.id)) {
        expect(["cancelled_provider_confirmed", "already_resolved", "preserved_ambiguous", "error"]).toContain(
          item.outcome,
        );
      }
    }
    // Repeated runs converge — whatever interleaving happened above.
    await runOrderExpirySweep(db, gateway, IMMEDIATE);
    await runOrderExpirySweep(db, gateway, IMMEDIATE);

    expect(await orderRow(order.id)).toMatchObject({ status: OrderStatus.CANCELLED });
    expect(await itemRow(v.inventoryItemId)).toMatchObject({ quantityOnHand: 10, quantityReserved: 0 });
    expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(1);
    // The invariant: the (single) provider intent for this order is not payable.
    expect((await gateway.findPaymentIntentForOrder(order.id))?.status).toBe("canceled");
    expect(gateway.intentCountFor(order.id)).toBe(1);
  });

  it("an admin cancellation of an order with an unresolved claim is refused (ConflictError) — same invariant, same lock", async () => {
    const gateway = new FakeStripeGateway();
    const { v, order } = await pendingOrder(10, 1);
    await claim(order.id, YOUNG);
    await expect(
      db.$transaction((tx) => applyOrderStatusTransitionTx(tx, order.id, OrderStatus.CANCELLED)),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await orderRow(order.id)).status).toBe(OrderStatus.PENDING);
    expect((await itemRow(v.inventoryItemId)).quantityReserved).toBe(1);
    expect(gateway.createCallCount).toBe(0);
  });

  it("real concurrency stress: startPayment racing the sweep never leaves a payable intent against released stock", async () => {
    for (let i = 0; i < 6; i++) {
      const gateway = new FakeStripeGateway();
      const { v, order } = await pendingOrder(10, 1);
      await Promise.allSettled([
        startPayment(order.orderNumber, { justPlaced: true }, {}, db, gateway),
        runOrderExpirySweep(db, gateway, IMMEDIATE),
      ]);
      // A just-created claim is "in flight" (young), so settle by aging it.
      await db.payment.updateMany({
        where: { orderId: order.id, providerPaymentId: null },
        data: { createdAt: new Date(Date.now() - IN_WINDOW) },
      });
      await runOrderExpirySweep(db, gateway, IMMEDIATE);
      await runOrderExpirySweep(db, gateway, IMMEDIATE);

      const o = await orderRow(order.id);
      const item = await itemRow(v.inventoryItemId);
      const pi = await gateway.findPaymentIntentForOrder(order.id);
      if (o.status === OrderStatus.CANCELLED) {
        expect(item.quantityReserved).toBe(0);
        expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(1);
        if (pi) expect(pi.status).toBe("canceled"); // never payable against released stock
      } else {
        expect(item.quantityReserved).toBe(1);
      }
      expect(gateway.intentCountFor(order.id)).toBeLessThanOrEqual(1);
    }
  });
});

describe("runOrderExpirySweep — a linked, still-payable PaymentIntent is never released solely for being old", () => {
  it("actively requests cancellation, and only releases once the provider confirms it", async () => {
    const gateway = new FakeStripeGateway();
    const { v, order } = await pendingOrder(10, 2);
    const payment = await startPayment(order.orderNumber, { justPlaced: true }, {}, db, gateway);
    expect(payment.alreadyPaid).toBe(false);

    const result = await runOrderExpirySweep(db, gateway, IMMEDIATE);

    expect(result.items).toContainEqual(
      expect.objectContaining({ orderId: order.id, outcome: "cancelled_provider_confirmed" }),
    );
    const fresh = await orderRow(order.id);
    expect(fresh).toMatchObject({ status: OrderStatus.CANCELLED, paymentStatus: PaymentStatus.FAILED });
    const item = await itemRow(v.inventoryItemId);
    expect(item).toMatchObject({ quantityOnHand: 10, quantityReserved: 0 });
    expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(1);

    const paymentRow = await db.payment.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(paymentRow.status).toBe("FAILED");
  });

  it("never interrupts an actively-processing payment, regardless of order age", async () => {
    const gateway = new FakeStripeGateway();
    const { v, order } = await pendingOrder(10, 1);
    const payment = await startPayment(order.orderNumber, { justPlaced: true }, {}, db, gateway);
    gateway.patch(
      (await db.payment.findUniqueOrThrow({ where: { orderId: order.id } })).providerPaymentId!,
      { status: "processing" },
    );
    void payment;

    const result = await runOrderExpirySweep(db, gateway, IMMEDIATE);

    expect(result.items).toContainEqual(
      expect.objectContaining({ orderId: order.id, outcome: "preserved_processing" }),
    );
    const fresh = await orderRow(order.id);
    expect(fresh).toMatchObject({ status: OrderStatus.PENDING, paymentStatus: PaymentStatus.UNPAID });
    const item = await itemRow(v.inventoryItemId);
    expect(item.quantityReserved).toBe(1); // still reserved — untouched
  });
});

describe("runOrderExpirySweep — payment success racing with expiry", () => {
  it("reconciles as PAID and commits stock, never cancels, when the provider reports success at check time", async () => {
    const gateway = new FakeStripeGateway();
    const { v, order } = await pendingOrder(10, 2);
    await startPayment(order.orderNumber, { justPlaced: true }, {}, db, gateway);
    const providerPaymentId = (await db.payment.findUniqueOrThrow({ where: { orderId: order.id } }))
      .providerPaymentId!;
    // The race: by the time this sweep asks, the payment has already
    // genuinely succeeded (e.g. a webhook settled it between this order
    // being scanned as a stale candidate and this check) — simulated here
    // by the provider itself now reporting "succeeded", exactly what a real
    // race would look like from this module's point of view.
    gateway.patch(providerPaymentId, { status: "succeeded" });

    const result = await runOrderExpirySweep(db, gateway, IMMEDIATE);

    expect(result.items).toContainEqual(
      expect.objectContaining({ orderId: order.id, outcome: "finalized_paid" }),
    );
    const fresh = await orderRow(order.id);
    expect(fresh).toMatchObject({ status: OrderStatus.CONFIRMED, paymentStatus: PaymentStatus.PAID });
    const item = await itemRow(v.inventoryItemId);
    expect(item).toMatchObject({ quantityOnHand: 8, quantityReserved: 0 }); // committed, not released
  });

  it("is a safe no-op when the webhook ALREADY fully reconciled the order before this sweep even ran", async () => {
    const gateway = new FakeStripeGateway();
    const { order } = await pendingOrder(10, 1);
    await startPayment(order.orderNumber, { justPlaced: true }, {}, db, gateway);
    const providerPaymentId = (await db.payment.findUniqueOrThrow({ where: { orderId: order.id } }))
      .providerPaymentId!;
    gateway.patch(providerPaymentId, { status: "succeeded" });
    // The webhook equivalent runs first and wins the race for real.
    const pi = await gateway.retrievePaymentIntent(providerPaymentId);
    const { finalizeFromPaymentIntent } = await import("@/server/orders/payment-service");
    await finalizeFromPaymentIntent(pi, "webhook", db, gateway);

    // This order is no longer PENDING, so the sweep's own query excludes it
    // entirely — the strongest possible form of "safe no-op."
    const result = await runOrderExpirySweep(db, gateway, IMMEDIATE);
    expect(result.items.find((i) => i.orderId === order.id)).toBeUndefined();
  });
});

describe("runOrderExpirySweep — an ambiguous provider failure preserves the reservation and retries safely", () => {
  it("leaves the order and reservation completely untouched on a network/timeout-shaped cancel failure, then succeeds on the next run", async () => {
    const gateway = new FakeStripeGateway();
    const { v, order } = await pendingOrder(10, 1);
    await startPayment(order.orderNumber, { justPlaced: true }, {}, db, gateway);
    const providerPaymentId = (await db.payment.findUniqueOrThrow({ where: { orderId: order.id } }))
      .providerPaymentId!;
    gateway.scriptCancelFailure(
      providerPaymentId,
      new PaymentGatewayError("Stripe: connection timed out", { ambiguous: true }),
    );

    const first = await runOrderExpirySweep(db, gateway, IMMEDIATE);
    expect(first.items).toContainEqual(
      expect.objectContaining({ orderId: order.id, outcome: "preserved_ambiguous" }),
    );
    const afterFirst = await orderRow(order.id);
    expect(afterFirst).toMatchObject({ status: OrderStatus.PENDING, paymentStatus: PaymentStatus.UNPAID });
    const itemAfterFirst = await itemRow(v.inventoryItemId);
    expect(itemAfterFirst.quantityReserved).toBe(1); // untouched

    // The scripted failure is one-shot — a later sweep (the "retry") now
    // reaches the real fake behaviour and succeeds.
    const second = await runOrderExpirySweep(db, gateway, IMMEDIATE);
    expect(second.items).toContainEqual(
      expect.objectContaining({ orderId: order.id, outcome: "cancelled_provider_confirmed" }),
    );
    const afterSecond = await orderRow(order.id);
    expect(afterSecond.status).toBe(OrderStatus.CANCELLED);
    const itemAfterSecond = await itemRow(v.inventoryItemId);
    expect(itemAfterSecond.quantityReserved).toBe(0);
  });
});

describe("runOrderExpirySweep — exactly-once inventory release under concurrent/duplicate workers", () => {
  it("two sweeps racing on the SAME no-PaymentIntent order release the reservation exactly once", async () => {
    const gatewayA = new FakeStripeGateway();
    const gatewayB = new FakeStripeGateway();
    const { v, order } = await pendingOrder(10, 4);

    const [resultA, resultB] = await Promise.all([
      runOrderExpirySweep(db, gatewayA, IMMEDIATE),
      runOrderExpirySweep(db, gatewayB, IMMEDIATE),
    ]);

    const outcomes = [...resultA.items, ...resultB.items]
      .filter((i) => i.orderId === order.id)
      .map((i) => i.outcome);
    // Both may report having acted (the Order-row read is not itself
    // serialised — see order-expiry.ts's own "Unresolved" note) but the
    // actual inventory effect must not double-apply regardless.
    expect(outcomes.length).toBeGreaterThan(0);

    const fresh = await orderRow(order.id);
    expect(fresh.status).toBe(OrderStatus.CANCELLED);
    const item = await itemRow(v.inventoryItemId);
    expect(item).toMatchObject({ quantityOnHand: 10, quantityReserved: 0 }); // exactly the original stock back
    // The real exactly-once proof: only one RELEASE movement was ever
    // recorded, regardless of how many sweeps raced on this order.
    expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(1);
  });

  it("two sweeps racing on the SAME linked-payment cancellation also release exactly once", async () => {
    const gatewayA = new FakeStripeGateway();
    const { v, order } = await pendingOrder(10, 3);
    await startPayment(order.orderNumber, { justPlaced: true }, {}, db, gatewayA);
    // Both "workers" share the same underlying fake provider state (a real
    // deployment's two workers would both be talking to the one real
    // Stripe account) — modelled here as the same gateway instance.
    const [resultA, resultB] = await Promise.all([
      runOrderExpirySweep(db, gatewayA, IMMEDIATE),
      runOrderExpirySweep(db, gatewayA, IMMEDIATE),
    ]);
    void resultA;
    void resultB;

    const fresh = await orderRow(order.id);
    expect(fresh.status).toBe(OrderStatus.CANCELLED);
    const item = await itemRow(v.inventoryItemId);
    expect(item).toMatchObject({ quantityOnHand: 10, quantityReserved: 0 });
    expect(await movementCount(v.inventoryItemId, StockMovementType.RELEASE)).toBe(1);
  });
});
