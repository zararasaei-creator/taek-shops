// @vitest-environment node
import { FulfillmentStatus, OrderStatus, PaymentStatus, UserRole } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { ForbiddenError, UnauthenticatedError } from "@/server/auth/errors";
import { InvalidStateTransitionError, NotFoundError } from "@/server/catalog/errors";
import {
  ADMIN_ORDER_STATUS_TRANSITIONS,
  FULFILLMENT_TRANSITIONS,
  canAdminTransitionOrder,
  canTransitionFulfillment,
  changeOrderFulfillmentStatus,
  changeOrderStatus,
  getOrderDetail,
  listOrders,
} from "@/server/orders/order-management-service";
import { createMockPrisma, type MockPrisma } from "./helpers/mock-prisma";

const staff = { id: "stf_1", role: UserRole.STAFF };
const manager = { id: "mgr_1", role: UserRole.MANAGER };
const customer = { id: "cus_1", role: UserRole.CUSTOMER };

describe("admin order-status transitions", () => {
  it("never allows PENDING -> CONFIRMED — that is payment-only", () => {
    expect(canAdminTransitionOrder(OrderStatus.PENDING, OrderStatus.CONFIRMED)).toBe(false);
    expect(ADMIN_ORDER_STATUS_TRANSITIONS[OrderStatus.PENDING]).not.toContain(OrderStatus.CONFIRMED);
  });

  it("is a strict subset of every legal transition an admin might request", () => {
    // Every admin-allowed transition must also be legal in the full state
    // machine — this module never invents a transition order-inventory.ts
    // wouldn't itself accept.
    for (const from of Object.values(OrderStatus)) {
      for (const to of ADMIN_ORDER_STATUS_TRANSITIONS[from]) {
        expect(to).not.toBe(from);
      }
    }
  });

  it("allows the expected forward and cancellation moves", () => {
    expect(canAdminTransitionOrder(OrderStatus.PENDING, OrderStatus.CANCELLED)).toBe(true);
    expect(canAdminTransitionOrder(OrderStatus.CONFIRMED, OrderStatus.PROCESSING)).toBe(true);
    expect(canAdminTransitionOrder(OrderStatus.CONFIRMED, OrderStatus.CANCELLED)).toBe(true);
    expect(canAdminTransitionOrder(OrderStatus.PROCESSING, OrderStatus.COMPLETED)).toBe(true);
    expect(canAdminTransitionOrder(OrderStatus.PROCESSING, OrderStatus.CANCELLED)).toBe(true);
  });

  it("terminal states accept nothing", () => {
    expect(ADMIN_ORDER_STATUS_TRANSITIONS[OrderStatus.COMPLETED]).toEqual([]);
    expect(ADMIN_ORDER_STATUS_TRANSITIONS[OrderStatus.CANCELLED]).toEqual([]);
  });
});

describe("changeOrderStatus", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
  });

  it("requires order.write", async () => {
    await expect(changeOrderStatus(null, "o1", OrderStatus.CANCELLED, db)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    await expect(changeOrderStatus(customer, "o1", OrderStatus.CANCELLED, db)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    // STAFF has order.read but not order.write.
    await expect(changeOrderStatus(staff, "o1", OrderStatus.CANCELLED, db)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("404s on an unknown order before checking transition legality", async () => {
    db.order.findUnique.mockResolvedValue(null);
    await expect(
      changeOrderStatus(manager, "missing", OrderStatus.CANCELLED, db),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects PENDING -> CONFIRMED with a payment-specific message, never reaching order.update", async () => {
    db.order.findUnique.mockResolvedValue({
      status: OrderStatus.PENDING,
      orderNumber: "ORD-1",
    } as never);

    await expect(
      changeOrderStatus(manager, "o1", OrderStatus.CONFIRMED, db),
    ).rejects.toThrow(/Stripe payment succeeds/);
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it("rejects any other illegal transition too", async () => {
    db.order.findUnique.mockResolvedValue({
      status: OrderStatus.COMPLETED,
      orderNumber: "ORD-1",
    } as never);

    await expect(
      changeOrderStatus(manager, "o1", OrderStatus.CANCELLED, db),
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it("delegates a legal transition to applyOrderStatusTransition (inventory + audit)", async () => {
    // First call: this module's own pre-check load.
    db.order.findUnique.mockResolvedValueOnce({
      status: OrderStatus.CONFIRMED,
      orderNumber: "ORD-1",
    } as never);
    // The Order-row lock every inventory-affecting transition now takes first.
    db.$queryRaw.mockResolvedValue([{ id: "o1", status: OrderStatus.CONFIRMED, paymentStatus: "PAID" }] as never);
    // Second call: inside applyOrderStatusTransition's own transaction load.
    db.order.findUnique.mockResolvedValueOnce({
      id: "o1",
      orderNumber: "ORD-1",
      status: OrderStatus.CONFIRMED,
      items: [{ variantId: "v1", quantity: 1 }],
    } as never);

    const result = await changeOrderStatus(manager, "o1", OrderStatus.PROCESSING, db);
    expect(result.from).toBe(OrderStatus.CONFIRMED);
    expect(result.to).toBe(OrderStatus.PROCESSING);
    expect(db.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: OrderStatus.PROCESSING }) }),
    );
  });
});

describe("fulfilment-status transitions", () => {
  it("never lets a returned or unfulfilled order jump backwards", () => {
    expect(FULFILLMENT_TRANSITIONS[FulfillmentStatus.RETURNED]).toEqual([]);
    expect(canTransitionFulfillment(FulfillmentStatus.FULFILLED, FulfillmentStatus.UNFULFILLED)).toBe(
      false,
    );
  });

  it("allows unfulfilled -> partially/fully fulfilled -> returned", () => {
    expect(
      canTransitionFulfillment(FulfillmentStatus.UNFULFILLED, FulfillmentStatus.PARTIALLY_FULFILLED),
    ).toBe(true);
    expect(canTransitionFulfillment(FulfillmentStatus.UNFULFILLED, FulfillmentStatus.FULFILLED)).toBe(
      true,
    );
    expect(
      canTransitionFulfillment(FulfillmentStatus.PARTIALLY_FULFILLED, FulfillmentStatus.FULFILLED),
    ).toBe(true);
    expect(canTransitionFulfillment(FulfillmentStatus.FULFILLED, FulfillmentStatus.RETURNED)).toBe(
      true,
    );
  });
});

describe("changeOrderFulfillmentStatus", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
  });

  it("requires order.write", async () => {
    await expect(
      changeOrderFulfillmentStatus(customer, "o1", FulfillmentStatus.FULFILLED, {}, db),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses to touch a cancelled order", async () => {
    db.order.findUnique.mockResolvedValue({
      orderNumber: "ORD-1",
      status: OrderStatus.CANCELLED,
      paymentStatus: PaymentStatus.REFUNDED,
      fulfillmentStatus: FulfillmentStatus.UNFULFILLED,
    } as never);

    await expect(
      changeOrderFulfillmentStatus(manager, "o1", FulfillmentStatus.FULFILLED, {}, db),
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it("refuses to mark an unpaid order as shipped — payment status stays authoritative", async () => {
    db.order.findUnique.mockResolvedValue({
      orderNumber: "ORD-1",
      status: OrderStatus.PENDING,
      paymentStatus: PaymentStatus.UNPAID,
      fulfillmentStatus: FulfillmentStatus.UNFULFILLED,
    } as never);

    await expect(
      changeOrderFulfillmentStatus(manager, "o1", FulfillmentStatus.FULFILLED, {}, db),
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
    expect(db.order.update).not.toHaveBeenCalled();
  });

  it("never writes inventory — fulfilment is informational only", async () => {
    db.order.findUnique.mockResolvedValue({
      orderNumber: "ORD-1",
      status: OrderStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      fulfillmentStatus: FulfillmentStatus.UNFULFILLED,
    } as never);

    await changeOrderFulfillmentStatus(manager, "o1", FulfillmentStatus.FULFILLED, {}, db);

    expect(db.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "o1" },
        data: { fulfillmentStatus: FulfillmentStatus.FULFILLED },
      }),
    );
    expect(db.stockMovement.create).not.toHaveBeenCalled();
    expect(db.inventoryItem.update).not.toHaveBeenCalled();
  });

  it("is a no-op when already in the target state", async () => {
    db.order.findUnique.mockResolvedValue({
      orderNumber: "ORD-1",
      status: OrderStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      fulfillmentStatus: FulfillmentStatus.FULFILLED,
    } as never);

    const result = await changeOrderFulfillmentStatus(
      manager,
      "o1",
      FulfillmentStatus.FULFILLED,
      {},
      db,
    );
    expect(result.from).toBe(FulfillmentStatus.FULFILLED);
    expect(db.order.update).not.toHaveBeenCalled();
  });
});

describe("listOrders / getOrderDetail authorization", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
    db.order.findMany.mockResolvedValue([]);
    db.order.count.mockResolvedValue(0);
  });

  it("listOrders requires order.read", async () => {
    await expect(listOrders(null, {}, db)).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(listOrders(customer, {}, db)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listOrders(staff, {}, db)).resolves.toEqual({ orders: [], total: 0 });
  });

  it("getOrderDetail requires order.read and 404s on a missing order", async () => {
    db.order.findUnique.mockResolvedValue(null);
    await expect(getOrderDetail(customer, "o1", db)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getOrderDetail(staff, "o1", db)).rejects.toBeInstanceOf(NotFoundError);
  });
});
