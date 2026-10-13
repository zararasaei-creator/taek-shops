// @vitest-environment node
import { OrderStatus, PaymentStatus } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConflictError, NotFoundError, CatalogValidationError } from "@/server/catalog/errors";
import { __setPaymentGateway } from "@/server/domain/payments";
import type { PaymentGateway, PaymentIntentView } from "@/server/domain/payments";
import {
  IDEMPOTENT_RECOVERY_MAX_AGE_MS,
  claimEra,
  finalizeFailureTx,
  finalizeFromPaymentIntentTx,
  startPayment,
} from "@/server/orders/payment-service";
import { createMockPrisma, type MockPrisma } from "./helpers/mock-prisma";

const applyTransitionTx = vi.fn();
vi.mock("@/server/orders/order-inventory", async (orig) => ({
  ...(await orig<typeof import("@/server/orders/order-inventory")>()),
  applyOrderStatusTransitionTx: (...args: unknown[]) => applyTransitionTx(...args),
}));

function pi(over: Partial<PaymentIntentView> = {}): PaymentIntentView {
  return {
    id: "pi_1",
    status: "succeeded",
    amount: 6850,
    amountReceived: 6850,
    currency: "cad",
    clientSecret: "pi_1_secret",
    metadata: { orderId: "o1", orderNumber: "TS-1" },
    card: { brand: "visa", last4: "4242" },
    lastError: null,
    ...over,
  };
}

const gateway: PaymentGateway = {
  provider: "stripe",
  createPaymentIntent: vi.fn(),
  retrievePaymentIntent: vi.fn(),
  cancelPaymentIntent: vi.fn(),
  findPaymentIntentForOrder: vi.fn(),
  parseWebhook: vi.fn(),
  refund: vi.fn(),
  retrieveRefund: vi.fn(),
};

let db: MockPrisma;

beforeEach(() => {
  db = createMockPrisma();
  applyTransitionTx
    .mockReset()
    .mockResolvedValue({ from: "PENDING", to: "CONFIRMED", effect: "commit" });
  vi.mocked(gateway.createPaymentIntent).mockReset();
  vi.mocked(gateway.retrievePaymentIntent).mockReset();
  __setPaymentGateway(gateway);
});
afterEach(() => __setPaymentGateway(null));

const pendingOrder = {
  id: "o1",
  orderNumber: "TS-1",
  userId: null,
  status: OrderStatus.PENDING,
  paymentStatus: PaymentStatus.UNPAID,
  totalCents: 6850,
  currency: "CAD",
  customerEmail: "b@example.com",
};

describe("startPayment", () => {
  it("rejects an unknown order and a non-payable order", async () => {
    db.order.findUnique.mockResolvedValue(null as never);
    await expect(startPayment("nope", { justPlaced: true }, {}, db)).rejects.toBeInstanceOf(
      NotFoundError,
    );

    db.order.findUnique.mockResolvedValue({
      ...pendingOrder,
      status: OrderStatus.CONFIRMED,
    } as never);
    await expect(startPayment("TS-1", { justPlaced: true }, {}, db)).rejects.toBeInstanceOf(
      CatalogValidationError,
    );
  });

  const lockedPending = () =>
    db.$queryRaw.mockResolvedValue([{ id: "o1", status: OrderStatus.PENDING, paymentStatus: "UNPAID" }] as never);

  it("derives the charge amount from order.totalCents and creates one intent", async () => {
    db.order.findUnique.mockResolvedValue(pendingOrder as never);
    db.payment.findUnique.mockResolvedValue(null as never);
    db.payment.create.mockResolvedValue({} as never);
    db.payment.updateMany.mockResolvedValue({ count: 1 } as never);
    db.auditLog.create.mockResolvedValue({} as never);
    lockedPending();
    vi.mocked(gateway.createPaymentIntent).mockResolvedValue(
      pi({ status: "requires_payment_method" }),
    );

    const res = await startPayment("TS-1", { justPlaced: true }, {}, db);
    expect(res.amountCents).toBe(6850);
    expect(res.clientSecret).toBe("pi_1_secret");
    const arg = vi.mocked(gateway.createPaymentIntent).mock.calls[0]![0];
    expect(arg.amountCents).toBe(6850);
    expect(arg.currency).toBe("cad");
    expect(arg.idempotencyKey).toBe("pi-create-o1");
  });

  it("commits the durable claim BEFORE any provider call, and the provider call runs outside every transaction", async () => {
    const events: string[] = [];
    db.order.findUnique.mockResolvedValue(pendingOrder as never);
    db.payment.findUnique.mockResolvedValue(null as never);
    db.payment.create.mockImplementation((() => {
      events.push("claim_written");
      return Promise.resolve({});
    }) as never);
    db.payment.updateMany.mockResolvedValue({ count: 1 } as never);
    db.auditLog.create.mockResolvedValue({} as never);
    lockedPending();
    let inTransaction = false;
    const inline = db.$transaction.getMockImplementation() as (arg: unknown) => unknown;
    db.$transaction.mockImplementation(((arg: unknown) => {
      inTransaction = true;
      events.push("tx_open");
      return Promise.resolve(inline(arg)).finally(() => {
        inTransaction = false;
        events.push("tx_closed");
      });
    }) as never);
    vi.mocked(gateway.createPaymentIntent).mockImplementation((() => {
      events.push(inTransaction ? "provider_call_INSIDE_tx" : "provider_call");
      return Promise.resolve(pi({ status: "requires_payment_method" }));
    }) as never);

    await startPayment("TS-1", { justPlaced: true }, {}, db);

    expect(events.indexOf("claim_written")).toBeGreaterThan(-1);
    expect(events.indexOf("claim_written")).toBeLessThan(events.indexOf("provider_call"));
    expect(events).not.toContain("provider_call_INSIDE_tx");
    expect(events.indexOf("tx_closed")).toBeLessThan(events.indexOf("provider_call"));
  });

  it("aborts BEFORE any provider call when the order is no longer payable once the lock is held (expiry/cancellation won first)", async () => {
    db.order.findUnique.mockResolvedValue(pendingOrder as never);
    db.payment.findUnique.mockResolvedValue(null as never);
    db.$queryRaw.mockResolvedValue([{ id: "o1", status: OrderStatus.CANCELLED, paymentStatus: "UNPAID" }] as never);

    await expect(startPayment("TS-1", { justPlaced: true }, {}, db)).rejects.toBeInstanceOf(
      CatalogValidationError,
    );
    expect(db.payment.create).not.toHaveBeenCalled();
    expect(gateway.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("fails closed — no provider call — on an unresolved claim older than the idempotency recovery window", async () => {
    db.order.findUnique.mockResolvedValue(pendingOrder as never);
    db.payment.findUnique.mockResolvedValue({
      providerPaymentId: null,
      createdAt: new Date(Date.now() - IDEMPOTENT_RECOVERY_MAX_AGE_MS - 1000),
    } as never);

    await expect(startPayment("TS-1", { justPlaced: true }, {}, db)).rejects.toBeInstanceOf(ConflictError);
    expect(gateway.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("reuses an existing live PaymentIntent instead of creating a second", async () => {
    db.order.findUnique.mockResolvedValue(pendingOrder as never);
    db.payment.findUnique.mockResolvedValue({ providerPaymentId: "pi_existing" } as never);
    vi.mocked(gateway.retrievePaymentIntent).mockResolvedValue(
      pi({ id: "pi_existing", status: "requires_payment_method", clientSecret: "cs_existing" }),
    );

    const res = await startPayment("TS-1", { justPlaced: true }, {}, db);
    expect(res.clientSecret).toBe("cs_existing");
    expect(gateway.createPaymentIntent).not.toHaveBeenCalled();
  });

  it("refuses to start payment for a viewer with no claim on the order", async () => {
    db.order.findUnique.mockResolvedValue(pendingOrder as never);
    await expect(startPayment("TS-1", { justPlaced: false }, {}, db)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("claimEra", () => {
  const since = new Date("2026-10-06T00:00:00Z");
  it("is legacy only when created before the configured boundary", () => {
    expect(claimEra(new Date("2026-10-05T23:59:59Z"), since)).toBe("legacy");
    expect(claimEra(new Date("2026-10-06T00:00:00Z"), since)).toBe("post_claim");
    expect(claimEra(new Date("2026-10-07T00:00:00Z"), since)).toBe("post_claim");
  });
  it("fails closed when the boundary is not configured — never asserts no pre-claim orders exist", () => {
    expect(claimEra(new Date("2020-01-01T00:00:00Z"), null)).toBe("unknown");
    expect(claimEra(new Date("2099-01-01T00:00:00Z"), null)).toBe("unknown");
  });
});

describe("finalizeFromPaymentIntentTx", () => {
  it("marks the order PAID and commits stock exactly once", async () => {
    db.order.findUnique.mockResolvedValue(pendingOrder as never);
    db.payment.updateMany.mockResolvedValue({ count: 1 } as never);
    db.order.update.mockResolvedValue({} as never);

    const { result } = await finalizeFromPaymentIntentTx(db, pi(), "webhook");
    expect(result.outcome).toBe("paid");
    expect(db.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { paymentStatus: PaymentStatus.PAID } }),
    );
    expect(applyTransitionTx).toHaveBeenCalledWith(db, "o1", OrderStatus.CONFIRMED);
  });

  it("is idempotent — a second success on a PAID order is a no-op", async () => {
    db.order.findUnique.mockResolvedValue({
      ...pendingOrder,
      paymentStatus: PaymentStatus.PAID,
    } as never);
    const { result } = await finalizeFromPaymentIntentTx(db, pi(), "webhook");
    expect(result.outcome).toBe("already_paid");
    expect(db.order.update).not.toHaveBeenCalled();
    expect(applyTransitionTx).not.toHaveBeenCalled();
  });

  it("rejects an amount / currency mismatch without marking the order paid", async () => {
    db.order.findUnique.mockResolvedValue(pendingOrder as never);
    db.payment.updateMany.mockResolvedValue({ count: 1 } as never);
    const { result, audit } = await finalizeFromPaymentIntentTx(db, pi({ amount: 1 }), "webhook");
    expect(result.outcome).toBe("amount_mismatch");
    expect(audit?.action).toBe("payment.amount_mismatch");
    expect(db.order.update).not.toHaveBeenCalled();
    expect(applyTransitionTx).not.toHaveBeenCalled();
  });

  it("handles a success that lands after the order was cancelled (refund required)", async () => {
    db.order.findUnique.mockResolvedValue({
      ...pendingOrder,
      status: OrderStatus.CANCELLED,
      paymentStatus: PaymentStatus.FAILED,
    } as never);
    db.payment.updateMany.mockResolvedValue({ count: 1 } as never);
    const { result, audit } = await finalizeFromPaymentIntentTx(db, pi(), "webhook");
    expect(result.outcome).toBe("late_success");
    expect(audit?.action).toBe("payment.late_success");
    expect(applyTransitionTx).not.toHaveBeenCalled();
  });
});

describe("finalizeFailureTx", () => {
  it("fails the payment, marks the order FAILED and releases stock", async () => {
    db.order.findUnique.mockResolvedValue(pendingOrder as never);
    db.payment.updateMany.mockResolvedValue({ count: 1 } as never);
    db.order.update.mockResolvedValue({} as never);
    applyTransitionTx.mockResolvedValue({ from: "PENDING", to: "CANCELLED", effect: "release" });

    const { result } = await finalizeFailureTx(
      db,
      pi({ status: "canceled" }),
      "webhook",
      "declined",
    );
    expect(result.outcome).toBe("failed");
    expect(db.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { paymentStatus: PaymentStatus.FAILED } }),
    );
    expect(applyTransitionTx).toHaveBeenCalledWith(db, "o1", OrderStatus.CANCELLED);
  });

  it("is a no-op when the order already succeeded (out-of-order event)", async () => {
    db.order.findUnique.mockResolvedValue({
      ...pendingOrder,
      status: OrderStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
    } as never);
    const { result, audit } = await finalizeFailureTx(db, pi(), "webhook", "declined");
    expect(result.outcome).toBe("already_failed");
    expect(audit?.action).toBe("payment.webhook.stale");
    expect(db.order.update).not.toHaveBeenCalled();
    expect(applyTransitionTx).not.toHaveBeenCalled();
  });
});
