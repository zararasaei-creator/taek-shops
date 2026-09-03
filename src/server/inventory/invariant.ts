import { Prisma, type PrismaClient } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { requirePermission, type AuthUser } from "@/server/auth/authorization";

/**
 * Inventory ledger reconciliation.
 *
 * The two running counters on `InventoryItem` are derived state: they must
 * always equal the sum of the append-only `StockMovement` ledger.
 *
 *   quantityOnHand   == SUM(StockMovement.quantityDelta)
 *   quantityReserved == SUM(StockMovement.reservedDelta)
 *
 * Plus the structural rules: neither counter is negative, and reserved never
 * exceeds on-hand. This module recomputes those sums straight from the database
 * and reports any `InventoryItem` that disagrees. Used by the Phase 5 invariant
 * tests and exposed read-only at `GET /api/admin/inventory/health` as an
 * operational check.
 */

type Db = Pick<PrismaClient, "$queryRaw">;

export interface InventoryReconciliation {
  inventoryItemId: string;
  variantId: string;
  sku: string;
  quantityOnHand: number;
  quantityReserved: number;
  ledgerOnHand: number;
  ledgerReserved: number;
  onHandConsistent: boolean;
  reservedConsistent: boolean;
  negativeOnHand: boolean;
  negativeReserved: boolean;
  reservedExceedsOnHand: boolean;
}

export interface InventoryHealthReport {
  ok: boolean;
  checkedAt: string;
  itemsChecked: number;
  anomalies: InventoryReconciliation[];
}

interface RawRow {
  inventoryItemId: string;
  variantId: string;
  sku: string;
  quantityOnHand: number;
  quantityReserved: number;
  ledgerOnHand: bigint | number | null;
  ledgerReserved: bigint | number | null;
}

function assess(row: RawRow): InventoryReconciliation {
  const ledgerOnHand = Number(row.ledgerOnHand ?? 0);
  const ledgerReserved = Number(row.ledgerReserved ?? 0);
  return {
    inventoryItemId: row.inventoryItemId,
    variantId: row.variantId,
    sku: row.sku,
    quantityOnHand: row.quantityOnHand,
    quantityReserved: row.quantityReserved,
    ledgerOnHand,
    ledgerReserved,
    onHandConsistent: row.quantityOnHand === ledgerOnHand,
    reservedConsistent: row.quantityReserved === ledgerReserved,
    negativeOnHand: row.quantityOnHand < 0,
    negativeReserved: row.quantityReserved < 0,
    reservedExceedsOnHand: row.quantityReserved > row.quantityOnHand,
  };
}

function isAnomaly(r: InventoryReconciliation): boolean {
  return (
    !r.onHandConsistent ||
    !r.reservedConsistent ||
    r.negativeOnHand ||
    r.negativeReserved ||
    r.reservedExceedsOnHand
  );
}

async function reconcileRows(db: Db): Promise<InventoryReconciliation[]> {
  const rows = await db.$queryRaw<RawRow[]>(Prisma.sql`
    SELECT i."id"               AS "inventoryItemId",
           i."variantId"        AS "variantId",
           v."sku"              AS "sku",
           i."quantityOnHand"   AS "quantityOnHand",
           i."quantityReserved" AS "quantityReserved",
           COALESCE(SUM(m."quantityDelta"), 0) AS "ledgerOnHand",
           COALESCE(SUM(m."reservedDelta"), 0) AS "ledgerReserved"
    FROM "InventoryItem" i
    JOIN "ProductVariant" v ON v."id" = i."variantId"
    LEFT JOIN "StockMovement" m ON m."inventoryItemId" = i."id"
    GROUP BY i."id", i."variantId", v."sku", i."quantityOnHand", i."quantityReserved"
  `);
  return rows.map(assess);
}

/** Reconcile every inventory item. */
export async function reconcileAllInventory(db: Db = prisma): Promise<InventoryHealthReport> {
  const all = await reconcileRows(db);
  return {
    ok: all.every((r) => !isAnomaly(r)),
    checkedAt: new Date().toISOString(),
    itemsChecked: all.length,
    anomalies: all.filter(isAnomaly),
  };
}

/** Reconcile a single variant (throws nothing; returns null if it has no item). */
export async function reconcileVariant(
  variantId: string,
  db: Db = prisma,
): Promise<InventoryReconciliation | null> {
  const all = await reconcileRows(db);
  return all.find((r) => r.variantId === variantId) ?? null;
}

/** Authorized entry point for the admin health endpoint. */
export async function inventoryHealth(
  actor: AuthUser | null | undefined,
  db: Db = prisma,
): Promise<InventoryHealthReport> {
  requirePermission(actor, "inventory.read");
  return reconcileAllInventory(db);
}
