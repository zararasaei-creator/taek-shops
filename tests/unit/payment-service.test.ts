// @vitest-environment node
import { OrderStatus, PaymentStatus } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NotFoundError, CatalogValidationError } from "@/server/catalog/errors";
import { __setPaymentGateway } from "@/server/domain/payments";
import type { PaymentGateway, PaymentIntentView } from "@/server/domain/payments";
import {
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
  parseWebhook: vi.fn(),
  refund: vi.fn(),
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

  it("derives the charge amount from order.totalCents and creates one intent", async () => {
    db.order.findUnique.mockResolvedValue(pendingOrder as never);
    db.payment.findUnique.mockResolvedValue(null as never);
    db.payment.create.mockResolvedValue({} as never);
    db.auditLog.create.mockResolvedValue({} as never);
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
