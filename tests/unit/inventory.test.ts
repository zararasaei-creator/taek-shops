// @vitest-environment node
import { StockMovementType, UserRole } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { ForbiddenError, UnauthenticatedError } from "@/server/auth/errors";
import { InventoryRuleError } from "@/server/catalog/errors";
import {
  adjustInventory,
  commitReservationTx,
  releaseReservationTx,
  reserveStockTx,
  restockTx,
} from "@/server/inventory/inventory-service";
import { createMockPrisma, type MockPrisma } from "./helpers/mock-prisma";

const manager = { id: "mgr_1", role: UserRole.MANAGER };
const staff = { id: "stf_1", role: UserRole.STAFF };

function stubItem(
  db: MockPrisma,
  overrides: Partial<{ onHand: number; reserved: number; reorderLevel: number | null }> = {},
) {
  const item = {
    id: "inv_1",
    quantityOnHand: overrides.onHand ?? 20,
    quantityReserved: overrides.reserved ?? 0,
    reorderLevel: overrides.reorderLevel ?? null,
    variant: { id: "var_1", sku: "SKU-1" },
  };
  db.productVariant.findUnique.mockResolvedValue({ id: "var_1" } as never);
  db.inventoryItem.findUnique.mockResolvedValue(item as never);
  db.inventoryItem.findFirst.mockResolvedValue(item as never);
  db.inventoryItem.update.mockResolvedValue({} as never);
  db.stockMovement.create.mockResolvedValue({ id: "mv_1" } as never);
  db.auditLog.create.mockResolvedValue({ id: "a" } as never);
  return item;
}

describe("adjustInventory", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
  });

  it("requires the inventory.write permission", async () => {
    stubItem(db);
    await expect(
      adjustInventory(null, { sku: "SKU-1", delta: 1, reason: "x" }, db),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(
      adjustInventory(staff, { sku: "SKU-1", delta: 1, reason: "x" }, db),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("applies a signed delta, writes a movement and an audit record", async () => {
    stubItem(db, { onHand: 20 });
    const level = await adjustInventory(
      manager,
      { sku: "SKU-1", delta: 5, reason: "Received", type: StockMovementType.PURCHASE },
      db,
    );
    expect(level.onHand).toBe(25);
    expect(db.stockMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ quantityDelta: 5, type: StockMovementType.PURCHASE }),
      }),
    );
    const audit = db.auditLog.create.mock.calls.at(-1)?.[0]?.data;
    expect(audit?.action).toBe("inventory.received");
  });

  it("supports setOnHand (absolute target)", async () => {
    stubItem(db, { onHand: 20 });
    const level = await adjustInventory(
      manager,
      { sku: "SKU-1", setOnHand: 8, reason: "count" },
      db,
    );
    expect(level.onHand).toBe(8);
    expect(db.stockMovement.create.mock.calls[0]![0].data).toMatchObject({ quantityDelta: -12 });
  });

  it("never lets on-hand go negative", async () => {
    stubItem(db, { onHand: 3 });
    await expect(
      adjustInventory(manager, { sku: "SKU-1", delta: -10, reason: "x" }, db),
    ).rejects.toBeInstanceOf(InventoryRuleError);
    expect(db.inventoryItem.update).not.toHaveBeenCalled();
  });

  it("never lets on-hand drop below reserved", async () => {
    stubItem(db, { onHand: 10, reserved: 8 });
    await expect(
      adjustInventory(manager, { sku: "SKU-1", setOnHand: 5, reason: "x" }, db),
    ).rejects.toBeInstanceOf(InventoryRuleError);
  });
});

describe("order-flow primitives", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
  });

  it("reserveStockTx checks availability", async () => {
    stubItem(db, { onHand: 10, reserved: 6 });
    await reserveStockTx(db, "var_1", 4, "ORDER-1");
    expect(db.inventoryItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { quantityReserved: 10 } }),
    );

    stubItem(db, { onHand: 10, reserved: 6 });
    await expect(reserveStockTx(db, "var_1", 5, "ORDER-2")).rejects.toBeInstanceOf(
      InventoryRuleError,
    );
  });

  it("commitReservationTx decrements on-hand and reserved together", async () => {
    stubItem(db, { onHand: 10, reserved: 4 });
    await commitReservationTx(db, "var_1", 4, "ORDER-1");
    expect(db.inventoryItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { quantityOnHand: 6, quantityReserved: 0 } }),
    );
    expect(db.stockMovement.create.mock.calls[0]![0].data).toMatchObject({
      type: StockMovementType.SALE,
      quantityDelta: -4,
    });
  });

  it("releaseReservationTx clamps to the reserved amount", async () => {
    stubItem(db, { onHand: 10, reserved: 3 });
    await releaseReservationTx(db, "var_1", 5, "ORDER-1");
    expect(db.inventoryItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { quantityReserved: 0 } }),
    );
  });

  it("restockTx returns units to on-hand", async () => {
    stubItem(db, { onHand: 10 });
    await restockTx(db, "var_1", 2, "REFUND-1");
    expect(db.inventoryItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { quantityOnHand: 12 } }),
    );
    expect(db.stockMovement.create.mock.calls[0]![0].data).toMatchObject({
      type: StockMovementType.RETURN,
    });
  });
});
