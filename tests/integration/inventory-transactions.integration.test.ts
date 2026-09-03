import { StockMovementType } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { InventoryRuleError } from "@/server/catalog/errors";
import {
  adjustInventory,
  commitReservationTx,
  releaseReservationTx,
  reserveStockTx,
  restockTx,
} from "@/server/inventory/inventory-service";
import {
  db,
  ensureActor,
  ledgerSums,
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

describe("adjustInventory (live DB)", () => {
  it("receives stock: counter and ledger both move, audit row written", async () => {
    const v = await makeVariant({ onHand: 10 });
    const level = await adjustInventory(actor, {
      sku: v.sku,
      delta: 5,
      reason: "PO-123",
      type: StockMovementType.PURCHASE,
    });
    expect(level.onHand).toBe(15);

    expect(await readItem(v.inventoryItemId)).toEqual({ quantityOnHand: 15, quantityReserved: 0 });
    expect((await ledgerSums(v.inventoryItemId)).onHand).toBe(15);

    const audit = await db.auditLog.findFirst({
      where: { entityType: "ProductVariant", entityId: v.variantId, action: "inventory.received" },
    });
    expect(audit).not.toBeNull();
  });

  it("setOnHand writes the balancing movement", async () => {
    const v = await makeVariant({ onHand: 20 });
    await adjustInventory(actor, { sku: v.sku, setOnHand: 8, reason: "cycle count" });
    expect((await readItem(v.inventoryItemId)).quantityOnHand).toBe(8);
    const last = await db.stockMovement.findFirst({
      where: { inventoryItemId: v.inventoryItemId, type: StockMovementType.ADJUSTMENT },
      orderBy: { createdAt: "desc" },
    });
    expect(last?.quantityDelta).toBe(-12);
    expect((await ledgerSums(v.inventoryItemId)).onHand).toBe(8);
  });

  it("refuses to drive on-hand negative and writes nothing", async () => {
    const v = await makeVariant({ onHand: 3 });
    await expect(
      adjustInventory(actor, { sku: v.sku, delta: -10, reason: "x" }),
    ).rejects.toBeInstanceOf(InventoryRuleError);
    expect((await readItem(v.inventoryItemId)).quantityOnHand).toBe(3);
    expect((await ledgerSums(v.inventoryItemId)).count).toBe(1); // only the opening balance
  });

  it("refuses to drop on-hand below what is reserved", async () => {
    const v = await makeVariant({ onHand: 10 });
    await db.$transaction((tx) => reserveStockTx(tx, v.variantId, 8, "hold"));
    await expect(
      adjustInventory(actor, { sku: v.sku, setOnHand: 5, reason: "x" }),
    ).rejects.toBeInstanceOf(InventoryRuleError);
    expect(await readItem(v.inventoryItemId)).toEqual({ quantityOnHand: 10, quantityReserved: 8 });
  });
});

describe("order-flow primitives (live DB)", () => {
  it("reserve → commit: on-hand leaves, reserved returns to zero, ledger reconciles", async () => {
    const v = await makeVariant({ onHand: 12 });

    await db.$transaction((tx) => reserveStockTx(tx, v.variantId, 5, "ORD-1"));
    expect(await readItem(v.inventoryItemId)).toEqual({ quantityOnHand: 12, quantityReserved: 5 });

    await db.$transaction((tx) => commitReservationTx(tx, v.variantId, 5, "ORD-1"));
    expect(await readItem(v.inventoryItemId)).toEqual({ quantityOnHand: 7, quantityReserved: 0 });

    const sums = await ledgerSums(v.inventoryItemId);
    expect(sums.onHand).toBe(7);
    expect(sums.reserved).toBe(0);
  });

  it("reserve → release restores availability", async () => {
    const v = await makeVariant({ onHand: 4 });
    await db.$transaction((tx) => reserveStockTx(tx, v.variantId, 4, "ORD-2"));
    await expect(
      db.$transaction((tx) => reserveStockTx(tx, v.variantId, 1, "ORD-3")),
    ).rejects.toBeInstanceOf(InventoryRuleError);

    await db.$transaction((tx) => releaseReservationTx(tx, v.variantId, 4, "ORD-2"));
    expect(await readItem(v.inventoryItemId)).toEqual({ quantityOnHand: 4, quantityReserved: 0 });
    // now it can be reserved again
    await db.$transaction((tx) => reserveStockTx(tx, v.variantId, 1, "ORD-3"));
    expect((await readItem(v.inventoryItemId)).quantityReserved).toBe(1);
  });

  it("release clamps to what is reserved (never negative)", async () => {
    const v = await makeVariant({ onHand: 6 });
    await db.$transaction((tx) => reserveStockTx(tx, v.variantId, 2, "ORD-4"));
    await db.$transaction((tx) => releaseReservationTx(tx, v.variantId, 10, "ORD-4"));
    expect((await readItem(v.inventoryItemId)).quantityReserved).toBe(0);
    expect((await ledgerSums(v.inventoryItemId)).reserved).toBe(0);
  });

  it("commit cannot exceed the reserved amount", async () => {
    const v = await makeVariant({ onHand: 10 });
    await db.$transaction((tx) => reserveStockTx(tx, v.variantId, 3, "ORD-5"));
    await expect(
      db.$transaction((tx) => commitReservationTx(tx, v.variantId, 5, "ORD-5")),
    ).rejects.toBeInstanceOf(InventoryRuleError);
    expect(await readItem(v.inventoryItemId)).toEqual({ quantityOnHand: 10, quantityReserved: 3 });
  });

  it("restock returns units and reconciles", async () => {
    const v = await makeVariant({ onHand: 5 });
    await db.$transaction((tx) => restockTx(tx, v.variantId, 3, "REFUND-1"));
    expect((await readItem(v.inventoryItemId)).quantityOnHand).toBe(8);
    expect((await ledgerSums(v.inventoryItemId)).onHand).toBe(8);
    const mv = await db.stockMovement.findFirst({
      where: { inventoryItemId: v.inventoryItemId, type: StockMovementType.RETURN },
    });
    expect(mv?.quantityDelta).toBe(3);
    expect(mv?.reservedDelta).toBe(0);
  });

  it("idempotencyKey makes a replayed reservation a no-op", async () => {
    const v = await makeVariant({ onHand: 10 });
    const key = "order:test-idem:reserve:" + v.variantId;
    await db.$transaction((tx) => reserveStockTx(tx, v.variantId, 4, "ORD-6", key));
    await db.$transaction((tx) => reserveStockTx(tx, v.variantId, 4, "ORD-6", key));
    await db.$transaction((tx) => reserveStockTx(tx, v.variantId, 4, "ORD-6", key));
    expect((await readItem(v.inventoryItemId)).quantityReserved).toBe(4);
    expect(
      await db.stockMovement.count({
        where: { inventoryItemId: v.inventoryItemId, type: StockMovementType.RESERVATION },
      }),
    ).toBe(1);
  });
});

describe("database CHECK constraints (defense in depth)", () => {
  it("rejects a direct negative on-hand write", async () => {
    const v = await makeVariant({ onHand: 2 });
    await expect(
      db.inventoryItem.update({ where: { id: v.inventoryItemId }, data: { quantityOnHand: -1 } }),
    ).rejects.toThrow();
  });

  it("rejects a direct write where reserved exceeds on-hand", async () => {
    const v = await makeVariant({ onHand: 2 });
    await expect(
      db.inventoryItem.update({ where: { id: v.inventoryItemId }, data: { quantityReserved: 5 } }),
    ).rejects.toThrow();
  });
});
