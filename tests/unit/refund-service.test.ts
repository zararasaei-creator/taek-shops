// @vitest-environment node
import { UserRole, PaymentTransactionStatus, RefundStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ForbiddenError, UnauthenticatedError } from "@/server/auth/errors";
import { CatalogValidationError } from "@/server/catalog/errors";
import type { PaymentGateway } from "@/server/domain/payments";
import { computeRefundSummary, requestRefund } from "@/server/orders/refund-service";
import { createMockPrisma, looseMock, type MockPrisma } from "./helpers/mock-prisma";

const manager = { id: "mgr", role: UserRole.MANAGER };
const staff = { id: "stf", role: UserRole.STAFF };
const customer = { id: "cus", role: UserRole.CUSTOMER };

describe("computeRefundSummary", () => {
  it("captures, confirmed-refunded, pending, and remaining are all consistent", () => {
    const summary = computeRefundSummary(
      { amountCents: 5000, refundedCents: 1000, currency: "CAD" },
      500,
    );
    expect(summary).toEqual({
      capturedCents: 5000,
      confirmedRefundedCents: 1000,
      pendingRefundedCents: 500,
      remainingCents: 3500,
      currency: "CAD",
    });
  });

  it("never reports a negative remaining balance", () => {
    // Defensive only — the service itself never lets confirmed+pending exceed
    // captured, but the pure summary function must not misbehave if it did.
    const summary = computeRefundSummary(
      { amountCents: 1000, refundedCents: 900, currency: "CAD" },
      200,
    );
    expect(summary.remainingCents).toBe(0);
  });
});

function wire(db: MockPrisma, opts: { paymentStatus?: PaymentTransactionStatus } = {}) {
  db.refund.findUnique.mockResolvedValue(null);
  db.order.findUnique.mockResolvedValue({ id: "order_1", orderNumber: "TS-1" } as never);
  looseMock(db.$queryRaw).mockImplementation(() =>
    Promise.resolve([
      {
        id: "pay_1",
        provider: "stripe",
        providerPaymentId: "pi_1",
        status: opts.paymentStatus ?? PaymentTransactionStatus.CAPTURED,
        amountCents: 5000,
        currency: "CAD",
        refundedCents: 0,
      },
    ]),
  );
  looseMock(db.refund.aggregate).mockImplementation(() =>
    Promise.resolve({ _sum: { amountCents: 0 } }),
  );
  const refundRow = {
    id: "refund_1",
    paymentId: "pay_1",
    amountCents: 1000,
    currency: "CAD",
    status: RefundStatus.PENDING,
    reason: "test",
    idempotencyKey: "k1_test_key_00001",
    provider: "stripe",
    providerRefundId: null,
    errorMessage: null,
    requestedById: "mgr",
  };
  db.refund.create.mockResolvedValue(refundRow as never);
  db.refund.findUniqueOrThrow.mockResolvedValue(refundRow as never);
  looseMock(db.refund.update).mockImplementation(({ data }) =>
    Promise.resolve({ ...refundRow, ...data }),
  );
  looseMock(db.payment.update).mockImplementation(({ data }) => {
    // `data.refundedCents` may be a Prisma `{ increment }` operation rather
    // than a plain number — these tests only assert the flow completes and
    // the right calls happen, never the resulting mocked value, so any
    // concrete number is fine.
    const refundedCents = typeof data.refundedCents === "number" ? data.refundedCents : 1000;
    return Promise.resolve({
      id: "pay_1",
      orderId: "order_1",
      amountCents: 5000,
      currency: "CAD",
      ...data,
      refundedCents,
      status: data.status ?? PaymentTransactionStatus.PARTIALLY_REFUNDED,
    });
  });
  db.order.update.mockResolvedValue({} as never);
  db.auditLog.create.mockResolvedValue({} as never);
}

const gateway: PaymentGateway = {
  provider: "stripe",
  createPaymentIntent: vi.fn(),
  retrievePaymentIntent: vi.fn(),
  cancelPaymentIntent: vi.fn(),
  findPaymentIntentForOrder: vi.fn(),
  parseWebhook: vi.fn(),
  refund: vi.fn().mockResolvedValue({
    id: "re_1",
    status: "succeeded",
    amountCents: 1000,
    paymentIntentId: "pi_1",
  }),
  retrieveRefund: vi.fn(),
};

const validInput = { amountCents: 1000, reason: "customer request", idempotencyKey: "k1_test_key_00001" };

describe("requestRefund — authorization (MANAGER/ADMIN only)", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
    vi.clearAllMocks();
    wire(db);
  });

  it("denies unauthenticated, denies CUSTOMER and STAFF, allows MANAGER", async () => {
    await expect(requestRefund(null, "order_1", validInput, {}, db, gateway)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    await expect(
      requestRefund(customer, "order_1", validInput, {}, db, gateway),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requestRefund(staff, "order_1", validInput, {}, db, gateway)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      requestRefund(manager, "order_1", validInput, {}, db, gateway),
    ).resolves.toBeDefined();
  });
});

describe("requestRefund — server-side validation", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
    vi.clearAllMocks();
    wire(db);
  });

  it("rejects a non-positive amount", async () => {
    await expect(
      requestRefund(manager, "order_1", { ...validInput, amountCents: 0 }, {}, db, gateway),
    ).rejects.toThrow(z.ZodError);
    await expect(
      requestRefund(manager, "order_1", { ...validInput, amountCents: -100 }, {}, db, gateway),
    ).rejects.toThrow(z.ZodError);
  });

  it("rejects an empty reason", async () => {
    await expect(
      requestRefund(manager, "order_1", { ...validInput, reason: "  " }, {}, db, gateway),
    ).rejects.toThrow(z.ZodError);
  });

  it("rejects an amount exceeding the refundable balance", async () => {
    looseMock(db.$queryRaw).mockImplementation(() =>
      Promise.resolve([
        {
          id: "pay_1",
          provider: "stripe",
          providerPaymentId: "pi_1",
          status: PaymentTransactionStatus.CAPTURED,
          amountCents: 5000,
          currency: "CAD",
          refundedCents: 4500,
        },
      ]),
    );
    await expect(
      requestRefund(manager, "order_1", { ...validInput, amountCents: 600 }, {}, db, gateway),
    ).rejects.toBeInstanceOf(CatalogValidationError);
    expect(db.refund.create).not.toHaveBeenCalled();
  });

  it("rejects a payment with no captured PaymentIntent", async () => {
    looseMock(db.$queryRaw).mockImplementation(() =>
      Promise.resolve([
        {
          id: "pay_1",
          provider: "stripe",
          providerPaymentId: null,
          status: PaymentTransactionStatus.PENDING,
          amountCents: 5000,
          currency: "CAD",
          refundedCents: 0,
        },
      ]),
    );
    await expect(
      requestRefund(manager, "order_1", validInput, {}, db, gateway),
    ).rejects.toBeInstanceOf(CatalogValidationError);
  });

  it("rejects a payment whose status cannot be refunded (e.g. already FAILED)", async () => {
    wire(db, { paymentStatus: PaymentTransactionStatus.FAILED });
    await expect(
      requestRefund(manager, "order_1", validInput, {}, db, gateway),
    ).rejects.toBeInstanceOf(CatalogValidationError);
  });
});

describe("requestRefund — idempotent short-circuit", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
    vi.clearAllMocks();
    wire(db);
  });

  it("an exact retry of an existing idempotency key never calls the gateway again", async () => {
    const existingRefund = {
      id: "refund_existing",
      status: RefundStatus.SUCCEEDED,
      idempotencyKey: "k1_test_key_00001",
    };
    db.refund.findUnique.mockResolvedValue(existingRefund as never);

    const result = await requestRefund(manager, "order_1", validInput, {}, db, gateway);
    expect(result).toBe(existingRefund);
    expect(gateway.refund).not.toHaveBeenCalled();
    expect(db.refund.create).not.toHaveBeenCalled();
  });
});
