// @vitest-environment node
import { UserRole } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { ForbiddenError } from "@/server/auth/errors";
import { inventoryHealth, reconcileAllInventory } from "@/server/inventory/invariant";
import { createMockPrisma, type MockPrisma } from "./helpers/mock-prisma";

function rows(db: MockPrisma, data: unknown[]) {
  db.$queryRaw.mockResolvedValue(data as never);
}

describe("inventory invariant reconciler", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
  });

  it("reports ok when every counter matches its ledger sum", async () => {
    rows(db, [
      {
        inventoryItemId: "i1",
        variantId: "v1",
        sku: "S1",
        quantityOnHand: 10,
        quantityReserved: 3,
        ledgerOnHand: 10n,
        ledgerReserved: 3n,
      },
    ]);
    const report = await reconcileAllInventory(db);
    expect(report.ok).toBe(true);
    expect(report.itemsChecked).toBe(1);
    expect(report.anomalies).toEqual([]);
  });

  it("flags on-hand / reserved drift and structural violations", async () => {
    rows(db, [
      {
        inventoryItemId: "i2",
        variantId: "v2",
        sku: "S2",
        quantityOnHand: 9,
        quantityReserved: 3,
        ledgerOnHand: 10n,
        ledgerReserved: 3n,
      },
      {
        inventoryItemId: "i3",
        variantId: "v3",
        sku: "S3",
        quantityOnHand: 2,
        quantityReserved: 5,
        ledgerOnHand: 2n,
        ledgerReserved: 5n,
      },
    ]);
    const report = await reconcileAllInventory(db);
    expect(report.ok).toBe(false);
    expect(report.anomalies).toHaveLength(2);
    expect(report.anomalies[0]).toMatchObject({ variantId: "v2", onHandConsistent: false });
    expect(report.anomalies[1]).toMatchObject({ variantId: "v3", reservedExceedsOnHand: true });
  });

  it("inventoryHealth enforces inventory.read", async () => {
    rows(db, []);
    await expect(inventoryHealth({ id: "c", role: UserRole.CUSTOMER }, db)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});
