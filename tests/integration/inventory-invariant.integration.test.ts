import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { InventoryRuleError } from "@/server/catalog/errors";
import {
  adjustInventory,
  commitReservationTx,
  releaseReservationTx,
  reserveStockTx,
  restockTx,
} from "@/server/inventory/inventory-service";
import { reconcileAllInventory, reconcileVariant } from "@/server/inventory/invariant";
import { db, ensureActor, makeVariant, readItem, teardown, type TestActor } from "./helpers/db";

let actor: TestActor;

beforeAll(async () => {
  actor = await ensureActor();
});
afterAll(teardown);

/** Deterministic PRNG so a failure is reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("inventory ledger invariant", () => {
  it("holds after a long randomized sequence of every operation", async () => {
    const v = await makeVariant({ onHand: 100 });
    const rnd = mulberry32(20260906);
    const ops = 200;

    for (let i = 0; i < ops; i++) {
      const roll = rnd();
      const qty = 1 + Math.floor(rnd() * 8);
      try {
        if (roll < 0.25) {
          await adjustInventory(actor, { sku: v.sku, delta: qty, reason: "receive" });
        } else if (roll < 0.4) {
          await adjustInventory(actor, { sku: v.sku, delta: -qty, reason: "shrink" });
        } else if (roll < 0.65) {
          await db.$transaction((tx) => reserveStockTx(tx, v.variantId, qty, `INV-${i}`));
        } else if (roll < 0.8) {
          await db.$transaction((tx) => releaseReservationTx(tx, v.variantId, qty, `INV-${i}`));
        } else if (roll < 0.92) {
          await db.$transaction((tx) => commitReservationTx(tx, v.variantId, qty, `INV-${i}`));
        } else {
          await db.$transaction((tx) => restockTx(tx, v.variantId, qty, `INV-${i}`));
        }
      } catch (err) {
        // A rejected operation is fine — it must simply have changed nothing.
        if (!(err instanceof InventoryRuleError)) throw err;
      }

      // Invariant must hold after EVERY step, not just at the end.
      const rec = await reconcileVariant(v.variantId);
      expect(rec, `step ${i}`).not.toBeNull();
      expect(rec!.onHandConsistent, `on-hand ledger drift at step ${i}`).toBe(true);
      expect(rec!.reservedConsistent, `reserved ledger drift at step ${i}`).toBe(true);
      expect(rec!.negativeOnHand).toBe(false);
      expect(rec!.negativeReserved).toBe(false);
      expect(rec!.reservedExceedsOnHand).toBe(false);
    }

    const item = await readItem(v.inventoryItemId);
    expect(item.quantityOnHand).toBeGreaterThanOrEqual(0);
    expect(item.quantityReserved).toBeGreaterThanOrEqual(0);
  });

  it("reconcileAllInventory reports ok for a clean database", async () => {
    await makeVariant({ onHand: 7 });
    await makeVariant({ onHand: 0 });
    const report = await reconcileAllInventory();
    expect(report.itemsChecked).toBeGreaterThan(0);
    expect(report.ok).toBe(true);
    expect(report.anomalies).toEqual([]);
  });

  it("detects a counter that has been corrupted out of band", async () => {
    const v = await makeVariant({ onHand: 10 });
    // Simulate corruption that bypasses the service layer but respects CHECKs.
    await db.$executeRawUnsafe(
      `UPDATE "InventoryItem" SET "quantityOnHand" = 9 WHERE "id" = $1`,
      v.inventoryItemId,
    );
    const rec = await reconcileVariant(v.variantId);
    expect(rec!.onHandConsistent).toBe(false);
    expect(rec!.quantityOnHand).toBe(9);
    expect(rec!.ledgerOnHand).toBe(10);

    const report = await reconcileAllInventory();
    expect(report.ok).toBe(false);
    expect(report.anomalies.some((a) => a.variantId === v.variantId)).toBe(true);
  });
});
