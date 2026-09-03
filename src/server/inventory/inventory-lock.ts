import { Prisma } from "@prisma/client";

import { NotFoundError } from "@/server/catalog/errors";

/**
 * Minimal transaction surface the inventory write path needs: the model
 * delegates plus `$queryRaw` for the `SELECT ... FOR UPDATE` row lock.
 */
export type InventoryTx = Pick<
  Prisma.TransactionClient,
  "inventoryItem" | "stockMovement" | "productVariant" | "$queryRaw"
>;

export interface LockedInventoryItem {
  id: string;
  variantId: string;
  sku: string;
  quantityOnHand: number;
  quantityReserved: number;
  reorderLevel: number | null;
}

/**
 * Acquire a row-level exclusive lock (`SELECT ... FOR UPDATE`) on a variant's
 * `InventoryItem` and return its current counters.
 *
 * Every stock-mutating transaction MUST call this before reading quantities or
 * deciding whether a change is allowed. Concurrent transactions touching the
 * same variant then serialize on this lock, so an availability check and the
 * write that depends on it are effectively atomic — overselling and lost
 * updates become impossible. READ COMMITTED (PostgreSQL's default) is sufficient
 * in combination with the lock: a transaction that blocks here re-reads the
 * just-committed counters when it proceeds, so its own guard checks run against
 * fresh data.
 *
 * Callers that lock more than one variant in the same transaction must lock in a
 * deterministic order (ascending `variantId`) to avoid deadlocks — see
 * `src/server/orders/order-inventory.ts`.
 */
export async function lockInventoryItem(
  tx: InventoryTx,
  variantId: string,
): Promise<LockedInventoryItem> {
  const rows = await tx.$queryRaw<LockedInventoryItem[]>(Prisma.sql`
    SELECT i."id",
           i."variantId",
           v."sku",
           i."quantityOnHand",
           i."quantityReserved",
           i."reorderLevel"
    FROM "InventoryItem" i
    JOIN "ProductVariant" v ON v."id" = i."variantId"
    WHERE i."variantId" = ${variantId}
    FOR UPDATE OF i
  `);

  const row = rows[0];
  if (!row) throw new NotFoundError("Inventory item", variantId);
  return row;
}

/**
 * True when a movement with this idempotency key already exists. Safe to call
 * only while holding the row lock for the variant the key belongs to (the key
 * encodes the variant id, so a concurrent writer of the same key is blocked on
 * the same lock).
 */
export async function movementExists(
  tx: Pick<Prisma.TransactionClient, "stockMovement">,
  idempotencyKey: string,
): Promise<boolean> {
  const existing = await tx.stockMovement.findUnique({
    where: { idempotencyKey },
    select: { id: true },
  });
  return existing !== null;
}
