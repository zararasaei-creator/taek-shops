// @vitest-environment node
import { OrderEmailStatus, OrderEmailType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  backoffMs,
  enqueueOrderEmailTx,
  kickEmailDispatch,
  resolveEmailJobFailure,
  resolveEmailJobSuccess,
  sendClaimedJob,
  type ClaimedEmailJob,
  type OrderMailer,
} from "@/server/notifications";
import { createMockPrisma, looseMock, type MockPrisma } from "../helpers/mock-prisma";

describe("backoffMs", () => {
  it("grows exponentially from the attempt count and is capped", () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(3)).toBe(120_000);
    expect(backoffMs(10)).toBe(30 * 60_000); // capped at 30 minutes
  });
});

describe("enqueueOrderEmailTx", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
  });

  it("creates the job row", async () => {
    await enqueueOrderEmailTx(db, "order_1", OrderEmailType.ORDER_CONFIRMATION);
    expect(db.orderEmail.create).toHaveBeenCalledWith({
      data: { orderId: "order_1", type: OrderEmailType.ORDER_CONFIRMATION },
    });
  });

  it("swallows a unique-constraint violation (duplicate qualifying event) instead of throwing", async () => {
    const { Prisma } = await import("@prisma/client");
    looseMock(db.orderEmail.create).mockImplementation(() => {
      throw new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "test",
      });
    });
    await expect(
      enqueueOrderEmailTx(db, "order_1", OrderEmailType.ORDER_CONFIRMATION),
    ).resolves.toBeUndefined();
  });

  it("re-throws a non-P2002 error", async () => {
    looseMock(db.orderEmail.create).mockImplementation(() => {
      throw new Error("connection lost");
    });
    await expect(
      enqueueOrderEmailTx(db, "order_1", OrderEmailType.ORDER_CONFIRMATION),
    ).rejects.toThrow("connection lost");
  });
});

describe("resolveEmailJobSuccess / resolveEmailJobFailure", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
  });

  it("marks SENT with a timestamp on success", async () => {
    await resolveEmailJobSuccess(db, "job_1");
    expect(db.orderEmail.update).toHaveBeenCalledWith({
      where: { id: "job_1" },
      data: { status: OrderEmailStatus.SENT, sentAt: expect.any(Date), lastError: null },
    });
  });

  it("schedules a retry (stays PENDING) when attempts have not exhausted maxAttempts", async () => {
    const job: ClaimedEmailJob = {
      id: "job_1",
      orderId: "order_1",
      type: OrderEmailType.ORDER_CONFIRMATION,
      idempotencyKey: "key_1",
      attempts: 2,
      maxAttempts: 5,
    };
    await resolveEmailJobFailure(db, job, new Error("smtp timeout"));
    expect(db.orderEmail.update).toHaveBeenCalledWith({
      where: { id: "job_1" },
      data: expect.objectContaining({
        status: OrderEmailStatus.PENDING,
        nextAttemptAt: expect.any(Date),
        lastError: "smtp timeout",
      }),
    });
  });

  it("marks terminally FAILED once attempts reach maxAttempts", async () => {
    const job: ClaimedEmailJob = {
      id: "job_1",
      orderId: "order_1",
      type: OrderEmailType.ORDER_CONFIRMATION,
      idempotencyKey: "key_1",
      attempts: 5,
      maxAttempts: 5,
    };
    await resolveEmailJobFailure(db, job, new Error("permanently rejected"));
    expect(db.orderEmail.update).toHaveBeenCalledWith({
      where: { id: "job_1" },
      data: { status: OrderEmailStatus.FAILED, lastError: "permanently rejected" },
    });
  });

  it("marks terminally FAILED immediately on a non-retryable ResendApiError, even on the very first attempt", async () => {
    const { ResendApiError } = await import("@/server/email/resend-client");
    const job: ClaimedEmailJob = {
      id: "job_1",
      orderId: "order_1",
      type: OrderEmailType.ORDER_CONFIRMATION,
      idempotencyKey: "key_1",
      attempts: 1,
      maxAttempts: 5,
    };
    await resolveEmailJobFailure(
      db,
      job,
      new ResendApiError("Resend API returned 403: domain not verified", 403, false),
    );
    expect(db.orderEmail.update).toHaveBeenCalledWith({
      where: { id: "job_1" },
      data: { status: OrderEmailStatus.FAILED, lastError: expect.stringContaining("403") },
    });
  });

  it("still retries a retryable ResendApiError (e.g. a 429) exactly like any other transient failure", async () => {
    const { ResendApiError } = await import("@/server/email/resend-client");
    const job: ClaimedEmailJob = {
      id: "job_1",
      orderId: "order_1",
      type: OrderEmailType.ORDER_CONFIRMATION,
      idempotencyKey: "key_1",
      attempts: 1,
      maxAttempts: 5,
    };
    await resolveEmailJobFailure(
      db,
      job,
      new ResendApiError("Resend API returned 429: rate_limit_exceeded", 429, true),
    );
    expect(db.orderEmail.update).toHaveBeenCalledWith({
      where: { id: "job_1" },
      data: expect.objectContaining({ status: OrderEmailStatus.PENDING, nextAttemptAt: expect.any(Date) }),
    });
  });
});

function wireOrderForSnapshot(db: MockPrisma): void {
  looseMock(db.order.findUniqueOrThrow).mockImplementation(() =>
    Promise.resolve({
      orderNumber: "TS-TEST-0001",
      currency: "CAD",
      customerEmail: "synthetic-customer@example.test",
      subtotalCents: 1000,
      discountCents: 0,
      shippingCents: 0,
      taxCents: 0,
      totalCents: 1000,
      items: [],
      addresses: [],
    }),
  );
}

describe("sendClaimedJob", () => {
  let db: MockPrisma;
  const job: ClaimedEmailJob = {
    id: "job_1",
    orderId: "order_1",
    type: OrderEmailType.ORDER_CONFIRMATION,
    idempotencyKey: "key_1",
    attempts: 1,
    maxAttempts: 5,
  };

  beforeEach(() => {
    db = createMockPrisma();
    wireOrderForSnapshot(db);
  });

  it("resolves SUCCESS and never throws when the transport succeeds", async () => {
    const mailer: OrderMailer = { send: vi.fn().mockResolvedValue(undefined) };
    await sendClaimedJob(db, job, mailer);
    expect(mailer.send).toHaveBeenCalledTimes(1);
    expect(mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "synthetic-customer@example.test",
        idempotencyKey: "key_1",
        type: OrderEmailType.ORDER_CONFIRMATION,
      }),
    );
    expect(db.orderEmail.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: OrderEmailStatus.SENT }) }),
    );
  });

  it("resolves FAILURE (never throws) when the transport throws", async () => {
    const mailer: OrderMailer = { send: vi.fn().mockRejectedValue(new Error("network down")) };
    await expect(sendClaimedJob(db, job, mailer)).resolves.toBeUndefined();
    expect(db.orderEmail.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastError: "network down" }),
      }),
    );
  });
});

describe("kickEmailDispatch", () => {
  it("never throws even if claiming/sending fails internally", async () => {
    const db = createMockPrisma();
    looseMock(db.$queryRaw).mockImplementation(() => {
      throw new Error("db exploded");
    });
    await expect(kickEmailDispatch(db)).resolves.toBeUndefined();
  });

  it("is a no-op when there is nothing to claim", async () => {
    const db = createMockPrisma();
    looseMock(db.$queryRaw).mockImplementation(() => Promise.resolve([]));
    await expect(kickEmailDispatch(db)).resolves.toBeUndefined();
    expect(db.orderEmail.update).not.toHaveBeenCalled();
  });
});
