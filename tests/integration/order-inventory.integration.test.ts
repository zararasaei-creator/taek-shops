import { OrderStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { InventoryRuleError, InvalidStateTransitionError } from "@/server/catalog/errors";
import {
  applyOrderStatusTransition,
  commitOrderStock,
  releaseOrderStock,
  reserveOrderStock,
  restockOrderStock,
} from "@/server/orders/order-inventory";
import { reconcileVariant } from "@/server/inventory/invariant";
import {
  db,
  ensureActor,
  ledgerSums,
  makeOrder,
  makeVariant,
  readItem,
  teardown,
  type TestActor,
} from "./helpers/db";

let actor: TestActor;

beforeAll(async () => {
  actor = await ensureActor();
});
afterAll(teardown);

describe("order lifecycle → inventory", () => {
  it("reserve on placement, commit on confirmation", async () => {
    const a = await makeVariant({ onHand: 10 });
    const b = await makeVariant({ onHand: 5 });
    const { orderId } = await makeOrder([
      { variantId: a.variantId, quantity: 3, sku: a.sku },
      { variantId: b.variantId, quantity: 2, sku: b.sku },
    ]);

    await reserveOrderStock(actor, orderId);
    expect(await readItem(a.inventoryItemId)).toEqual({ quantityOnHand: 10, quantityReserved: 3 });
    expect(await readItem(b.inventoryItemId)).toEqual({ quantityOnHand: 5, quantityReserved: 2 });

    await applyOrderStatusTransition(actor, orderId, OrderStatus.CONFIRMED);
    expect(await readItem(a.inventoryItemId)).toEqual({ quantityOnHand: 7, quantityReserved: 0 });
    expect(await readItem(b.inventoryItemId)).toEqual({ quantityOnHand: 3, quantityReserved: 0 });

    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe(OrderStatus.CONFIRMED);
    expect(order.placedAt).not.toBeNull();

    expect((await ledgerSums(a.inventoryItemId)).onHand).toBe(7);
    expect((await reconcileVariant(a.variantId))!.onHandConsistent).toBe(true);
  });

  it("releaseOrderStock frees a reservation directly", async () => {
    const v = await makeVariant({ onHand: 8 });
    const { orderId } = await makeOrder([{ variantId: v.variantId, quantity: 5, sku: v.sku }]);
    await reserveOrderStock(actor, orderId);
    await releaseOrderStock(actor, orderId);
    expect(await readItem(v.inventoryItemId)).toEqual({ quantityOnHand: 8, quantityReserved: 0 });
  });

  it("cancel before confirmation releases the reservation", async () => {
    const v = await makeVariant({ onHand: 8 });
    const { orderId } = await makeOrder([{ variantId: v.variantId, quantity: 5, sku: v.sku }]);

    await reserveOrderStock(actor, orderId);
    expect((await readItem(v.inventoryItemId)).quantityReserved).toBe(5);

    await applyOrderStatusTransition(actor, orderId, OrderStatus.CANCELLED);
    expect(await readItem(v.inventoryItemId)).toEqual({ quantityOnHand: 8, quantityReserved: 0 });
    expect(
      (await db.order.findUniqueOrThrow({ where: { id: orderId } })).cancelledAt,
    ).not.toBeNull();
  });

  it("cancel after confirmation restocks the committed units", async () => {
    const v = await makeVariant({ onHand: 12 });
    const { orderId } = await makeOrder([{ variantId: v.variantId, quantity: 4, sku: v.sku }]);

    await reserveOrderStock(actor, orderId);
    await applyOrderStatusTransition(actor, orderId, OrderStatus.CONFIRMED);
    expect((await readItem(v.inventoryItemId)).quantityOnHand).toBe(8);

    await applyOrderStatusTransition(actor, orderId, OrderStatus.CANCELLED);
    expect(await readItem(v.inventoryItemId)).toEqual({ quantityOnHand: 12, quantityReserved: 0 });
    expect((await reconcileVariant(v.variantId))!.onHandConsistent).toBe(true);
  });

  it("every order operation is idempotent under replay", async () => {
    const v = await makeVariant({ onHand: 10 });
    const { orderId } = await makeOrder([{ variantId: v.variantId, quantity: 3, sku: v.sku }]);

    await reserveOrderStock(actor, orderId);
    await reserveOrderStock(actor, orderId);
    await reserveOrderStock(actor, orderId);
    expect((await readItem(v.inventoryItemId)).quantityReserved).toBe(3);

    await commitOrderStock(actor, orderId);
    await commitOrderStock(actor, orderId);
    expect(await readItem(v.inventoryItemId)).toEqual({ quantityOnHand: 7, quantityReserved: 0 });

    await restockOrderStock(actor, orderId);
    await restockOrderStock(actor, orderId);
    // committed 3 out, restocked 3 back → net back to the opening 10
    expect((await readItem(v.inventoryItemId)).quantityOnHand).toBe(10);

    // exactly one movement of each kind
    const grouped = await db.stockMovement.groupBy({
      by: ["type"],
      where: { inventoryItemId: v.inventoryItemId },
      _count: true,
    });
    const counts = Object.fromEntries(grouped.map((g) => [g.type, g._count]));
    expect(counts.RESERVATION).toBe(1);
    expect(counts.SALE).toBe(1);
    expect(counts.RETURN).toBe(1);
  });

  it("an order that exceeds availability reserves nothing (atomic)", async () => {
    const a = await makeVariant({ onHand: 10 });
    const b = await makeVariant({ onHand: 1 }); // too little for the 4 requested
    const { orderId } = await makeOrder([
      { variantId: a.variantId, quantity: 4, sku: a.sku },
      { variantId: b.variantId, quantity: 4, sku: b.sku },
    ]);

    await expect(reserveOrderStock(actor, orderId)).rejects.toBeInstanceOf(InventoryRuleError);

    // first line must have rolled back too
    expect(await readItem(a.inventoryItemId)).toEqual({ quantityOnHand: 10, quantityReserved: 0 });
    expect(await readItem(b.inventoryItemId)).toEqual({ quantityOnHand: 1, quantityReserved: 0 });
  });

  it("rejects an illegal status transition", async () => {
    const v = await makeVariant({ onHand: 5 });
    const { orderId } = await makeOrder([{ variantId: v.variantId, quantity: 1, sku: v.sku }]);
    await reserveOrderStock(actor, orderId);
    await expect(
      applyOrderStatusTransition(actor, orderId, OrderStatus.COMPLETED),
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(
      OrderStatus.PENDING,
    );
  });

  it("aggregates duplicate lines for the same variant", async () => {
    const v = await makeVariant({ onHand: 10 });
    const { orderId } = await makeOrder([
      { variantId: v.variantId, quantity: 2, sku: v.sku },
      { variantId: v.variantId, quantity: 3, sku: v.sku },
    ]);
    await reserveOrderStock(actor, orderId);
    expect((await readItem(v.inventoryItemId)).quantityReserved).toBe(5);
    expect(
      await db.stockMovement.count({
        where: { inventoryItemId: v.inventoryItemId, type: "RESERVATION" },
      }),
    ).toBe(1);
  });
});
