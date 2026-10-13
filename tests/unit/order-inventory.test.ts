// @vitest-environment node
import { OrderStatus, UserRole } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { ForbiddenError, UnauthenticatedError } from "@/server/auth/errors";
import { ConflictError, InvalidStateTransitionError } from "@/server/catalog/errors";
import {
  ORDER_STATUS_TRANSITIONS,
  applyOrderStatusTransition,
  canTransitionOrder,
  inventoryEffectForTransition,
  reserveOrderStock,
} from "@/server/orders/order-inventory";
import { createMockPrisma, type MockPrisma } from "./helpers/mock-prisma";

const manager = { id: "mgr_1", role: UserRole.MANAGER };
const customer = { id: "cus_1", role: UserRole.CUSTOMER };

describe("order-status state machine", () => {
  it("allows only the intended transitions", () => {
    expect(canTransitionOrder(OrderStatus.PENDING, OrderStatus.CONFIRMED)).toBe(true);
    expect(canTransitionOrder(OrderStatus.PENDING, OrderStatus.CANCELLED)).toBe(true);
    expect(canTransitionOrder(OrderStatus.PENDING, OrderStatus.COMPLETED)).toBe(false);
    expect(canTransitionOrder(OrderStatus.CONFIRMED, OrderStatus.PROCESSING)).toBe(true);
    expect(canTransitionOrder(OrderStatus.COMPLETED, OrderStatus.CANCELLED)).toBe(false);
    expect(canTransitionOrder(OrderStatus.CANCELLED, OrderStatus.PENDING)).toBe(false);
  });

  it("terminal states have no outgoing transitions", () => {
    expect(ORDER_STATUS_TRANSITIONS[OrderStatus.COMPLETED]).toEqual([]);
    expect(ORDER_STATUS_TRANSITIONS[OrderStatus.CANCELLED]).toEqual([]);
  });

  it("maps transitions to the correct inventory operation", () => {
    expect(inventoryEffectForTransition(OrderStatus.PENDING, OrderStatus.CONFIRMED)).toBe("commit");
    expect(inventoryEffectForTransition(OrderStatus.PENDING, OrderStatus.CANCELLED)).toBe(
      "release",
    );
    expect(inventoryEffectForTransition(OrderStatus.CONFIRMED, OrderStatus.CANCELLED)).toBe(
      "restock",
    );
    expect(inventoryEffectForTransition(OrderStatus.PROCESSING, OrderStatus.CANCELLED)).toBe(
      "restock",
    );
    expect(inventoryEffectForTransition(OrderStatus.CONFIRMED, OrderStatus.PROCESSING)).toBeNull();
    expect(inventoryEffectForTransition(OrderStatus.PROCESSING, OrderStatus.COMPLETED)).toBeNull();
  });
});

describe("order-inventory authorization", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
  });

  it("requires order.write", async () => {
    await expect(reserveOrderStock(null, "o1", db)).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(reserveOrderStock(customer, "o1", db)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("applyOrderStatusTransition", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
  });

  /** The Order-row `SELECT ... FOR UPDATE` lock (`lockOrderRow`) every transition now takes first. */
  const lockOrder = (status: OrderStatus) =>
    db.$queryRaw.mockResolvedValue([{ id: "o1", status, paymentStatus: "UNPAID" }] as never);

  it("rejects an illegal transition without touching inventory", async () => {
    lockOrder(OrderStatus.PENDING);
    db.order.findUnique.mockResolvedValue({
      id: "o1",
      orderNumber: "ORD-1",
      status: OrderStatus.PENDING,
      items: [{ variantId: "v1", quantity: 1 }],
    } as never);

    await expect(
      applyOrderStatusTransition(manager, "o1", OrderStatus.COMPLETED, db),
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);

    expect(db.order.update).not.toHaveBeenCalled();
    expect(db.stockMovement.create).not.toHaveBeenCalled();
  });

  it.each([
    ["an unresolved creation claim", null],
    ["a linked PaymentIntent the provider has not confirmed cancelled", "pi_live"],
  ])("refuses to RELEASE stock while the order has %s", async (_label, providerPaymentId) => {
    lockOrder(OrderStatus.PENDING);
    db.order.findUnique.mockResolvedValue({
      id: "o1",
      orderNumber: "ORD-1",
      status: OrderStatus.PENDING,
      items: [{ variantId: "v1", quantity: 1 }],
    } as never);
    db.payment.findFirst.mockResolvedValue({ providerPaymentId } as never);

    await expect(
      applyOrderStatusTransition(manager, "o1", OrderStatus.CANCELLED, db),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(db.order.update).not.toHaveBeenCalled();
    expect(db.stockMovement.create).not.toHaveBeenCalled();
    // Only non-terminal payments block: the guard filters out FAILED/CANCELLED rows.
    expect(db.payment.findFirst.mock.calls[0]![0]).toMatchObject({
      where: { orderId: "o1", status: { notIn: ["FAILED", "CANCELLED"] } },
    });
  });

  it("is a no-op when already in the target state", async () => {
    lockOrder(OrderStatus.CONFIRMED);
    db.order.findUnique.mockResolvedValue({
      id: "o1",
      orderNumber: "ORD-1",
      status: OrderStatus.CONFIRMED,
      items: [],
    } as never);

    const result = await applyOrderStatusTransition(manager, "o1", OrderStatus.CONFIRMED, db);
    expect(result.inventoryEffect).toBeNull();
    expect(db.order.update).not.toHaveBeenCalled();
  });
});
