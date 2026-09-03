import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { InventoryRuleError } from "@/server/catalog/errors";
import { adjustInventory, reserveStockTx } from "@/server/inventory/inventory-service";
import { reserveOrderStock } from "@/server/orders/order-inventory";
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

function settle<T>(promises: Promise<T>[]) {
  return Promise.allSettled(promises);
}

describe("concurrent reservations cannot oversell", () => {
  it("50 parallel single-unit reservations against 20 on-hand: exactly 20 win", async () => {
    const stock = 20;
    const attempts = 50;
    const v = await makeVariant({ onHand: stock });

    const results = await settle(
      Array.from({ length: attempts }, (_, i) =>
        db.$transaction((tx) => reserveStockTx(tx, v.variantId, 1, `RACE-${i}`), {
          timeout: 20_000,
        }),
      ),
    );

    const ok = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof InventoryRuleError,
    ).length;

    expect(ok).toBe(stock);
    expect(failed).toBe(attempts - stock);

    const item = await readItem(v.inventoryItemId);
    expect(item).toEqual({ quantityOnHand: stock, quantityReserved: stock });

    const sums = await ledgerSums(v.inventoryItemId);
    expect(sums.reserved).toBe(stock); // reserved counter == SUM(reservedDelta)
    expect(sums.onHand).toBe(stock);
  });

  it("parallel multi-unit reservations never exceed availability", async () => {
    const v = await makeVariant({ onHand: 100 });
    const sizes = [30, 30, 30, 30, 30]; // 150 requested, only 100 available
    const results = await settle(
      sizes.map((qty, i) =>
        db.$transaction((tx) => reserveStockTx(tx, v.variantId, qty, `MULTI-${i}`), {
          timeout: 20_000,
        }),
      ),
    );
    // Row-lock serialization: each request is all-or-nothing 30 units, so exactly
    // floor(100 / 30) = 3 succeed regardless of arrival order.
    const won = results.filter((r) => r.status === "fulfilled").length;
    expect(won).toBe(3);
    const item = await readItem(v.inventoryItemId);
    expect(item.quantityReserved).toBe(90);
    expect(item.quantityReserved).toBeLessThanOrEqual(100);
  });

  it("parallel order reservations across a shared variant do not oversell", async () => {
    const v = await makeVariant({ onHand: 15 });
    const orders = await Promise.all(
      Array.from({ length: 10 }, () =>
        makeOrder([{ variantId: v.variantId, quantity: 2, sku: v.sku }], "PENDING").then(
          (o) => o.orderId,
        ),
      ),
    );

    const results = await settle(orders.map((id) => reserveOrderStock(actor, id)));
    const won = results.filter((r) => r.status === "fulfilled").length;

    expect(won).toBe(7); // 7 * 2 = 14 <= 15; the 8th (needing 16) fails
    const item = await readItem(v.inventoryItemId);
    expect(item.quantityReserved).toBe(won * 2);
    expect(item.quantityReserved).toBeLessThanOrEqual(15);
  });

  it("reservation racing an adjustment stays consistent", async () => {
    const v = await makeVariant({ onHand: 40 });

    const work: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      work.push(
        db
          .$transaction((tx) => reserveStockTx(tx, v.variantId, 1, `R-${i}`), { timeout: 20_000 })
          .catch(() => undefined),
      );
      work.push(
        adjustInventory(actor, { sku: v.sku, delta: -1, reason: "shrinkage" }).catch(
          () => undefined,
        ),
      );
    }
    await Promise.all(work);

    const item = await readItem(v.inventoryItemId);
    expect(item.quantityOnHand).toBeGreaterThanOrEqual(0);
    expect(item.quantityReserved).toBeGreaterThanOrEqual(0);
    expect(item.quantityReserved).toBeLessThanOrEqual(item.quantityOnHand);

    const rec = await reconcileVariant(v.variantId);
    expect(rec?.onHandConsistent).toBe(true);
    expect(rec?.reservedConsistent).toBe(true);
  });
});
