import { StockMovementType, type Prisma, type PrismaClient } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { requirePermission, type AuthUser } from "@/server/auth/authorization";
import { recordAudit } from "@/server/audit/audit-service";
import { AUDIT_ACTIONS } from "@/server/audit/actions";
import { InventoryRuleError, NotFoundError } from "@/server/catalog/errors";
import type { CatalogTxClient } from "@/server/catalog/tx";
import { inventoryAdjustSchema, type InventoryAdjustInput } from "@/lib/validation/catalog";

/**
 * The single controlled entry point for stock changes.
 *
 * Rules (never silently violated):
 * - `quantityOnHand` is never negative;
 * - `quantityOnHand` is never dropped below `quantityReserved` (that would make
 *   an existing reservation unfulfillable);
 * - every change writes an append-only `StockMovement` in the same transaction
 *   as the counter update;
 * - `available = quantityOnHand - quantityReserved` is derived, never stored.
 *
 * Order placement / cancellation call `reserveStockTx` / `releaseReservationTx` /
 * `commitReservationTx` / `restockTx` — the same primitives, so the order flow
 * can be built later without touching this domain.
 */

type Db = PrismaClient;
type Actor = AuthUser | null | undefined;
type ItemTx = Pick<CatalogTxClient, "inventoryItem" | "stockMovement" | "productVariant">;

interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface InventoryLevel {
  variantId: string;
  sku: string;
  inventoryItemId: string;
  onHand: number;
  reserved: number;
  available: number;
  reorderLevel: number | null;
  belowReorderLevel: boolean;
}

function toLevel(row: {
  id: string;
  quantityOnHand: number;
  quantityReserved: number;
  reorderLevel: number | null;
  variant: { id: string; sku: string };
}): InventoryLevel {
  const available = row.quantityOnHand - row.quantityReserved;
  return {
    variantId: row.variant.id,
    sku: row.variant.sku,
    inventoryItemId: row.id,
    onHand: row.quantityOnHand,
    reserved: row.quantityReserved,
    available,
    reorderLevel: row.reorderLevel,
    belowReorderLevel: row.reorderLevel != null && available <= row.reorderLevel,
  };
}

const levelSelect = {
  id: true,
  quantityOnHand: true,
  quantityReserved: true,
  reorderLevel: true,
  variant: { select: { id: true, sku: true } },
} satisfies Prisma.InventoryItemSelect;

async function loadItemForUpdate(
  tx: ItemTx,
  where: { variantId: string } | { sku: string },
): Promise<{
  id: string;
  quantityOnHand: number;
  quantityReserved: number;
  reorderLevel: number | null;
  variant: { id: string; sku: string };
}> {
  const variantId =
    "variantId" in where
      ? where.variantId
      : (
          await tx.productVariant.findUnique({
            where: { sku: where.sku },
            select: { id: true },
          })
        )?.id;

  if (!variantId) throw new NotFoundError("Variant", "sku" in where ? where.sku : where.variantId);

  const item = await tx.inventoryItem.findUnique({ where: { variantId }, select: levelSelect });
  if (!item) throw new NotFoundError("Inventory item", variantId);
  return item;
}

/** Apply a signed change to on-hand stock + write the movement. Enforces the rules. */
async function applyOnHandDeltaTx(
  tx: ItemTx,
  itemId: string,
  currentOnHand: number,
  currentReserved: number,
  delta: number,
  movement: {
    type: StockMovementType;
    variantId: string;
    reason: string;
    reference?: string | null;
    actorId?: string | null;
  },
): Promise<number> {
  const nextOnHand = currentOnHand + delta;
  if (nextOnHand < 0) {
    throw new InventoryRuleError(
      `Adjustment would make on-hand stock negative (${currentOnHand} -> ${nextOnHand}).`,
    );
  }
  if (nextOnHand < currentReserved) {
    throw new InventoryRuleError(
      `Adjustment would leave ${currentReserved} reserved unit(s) unfulfillable (on-hand ${nextOnHand}).`,
    );
  }

  await tx.inventoryItem.update({
    where: { id: itemId },
    data: { quantityOnHand: nextOnHand },
  });
  await tx.stockMovement.create({
    data: {
      inventoryItemId: itemId,
      variantId: movement.variantId,
      type: movement.type,
      quantityDelta: delta,
      reason: movement.reason,
      reference: movement.reference ?? null,
      actorId: movement.actorId ?? null,
    },
  });
  return nextOnHand;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getInventoryLevel(
  actor: Actor,
  variantIdOrSku: string,
  db: Db = prisma,
): Promise<InventoryLevel> {
  requirePermission(actor, "inventory.read");
  const item = await db.inventoryItem.findFirst({
    where: { OR: [{ variantId: variantIdOrSku }, { variant: { sku: variantIdOrSku } }] },
    select: levelSelect,
  });
  if (!item) throw new NotFoundError("Inventory item", variantIdOrSku);
  return toLevel(item);
}

export async function listLowStock(actor: Actor, db: Db = prisma): Promise<InventoryLevel[]> {
  requirePermission(actor, "inventory.read");
  const items = await db.inventoryItem.findMany({
    where: { reorderLevel: { not: null } },
    select: levelSelect,
  });
  return items.map(toLevel).filter((l) => l.belowReorderLevel);
}

export async function listVariantMovements(
  actor: Actor,
  variantId: string,
  limit = 50,
  db: Db = prisma,
): Promise<
  Prisma.StockMovementGetPayload<{
    select: {
      id: true;
      type: true;
      quantityDelta: true;
      reason: true;
      reference: true;
      createdAt: true;
      actorId: true;
    };
  }>[]
> {
  requirePermission(actor, "inventory.read");
  return db.stockMovement.findMany({
    where: { variantId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
    select: {
      id: true,
      type: true,
      quantityDelta: true,
      reason: true,
      reference: true,
      createdAt: true,
      actorId: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Admin adjustment (the only manual mutation entry point)
// ---------------------------------------------------------------------------

export async function adjustInventory(
  actor: Actor,
  rawInput: InventoryAdjustInput & Meta,
  db: Db = prisma,
): Promise<InventoryLevel> {
  const authed = requirePermission(actor, "inventory.write");
  const input = inventoryAdjustSchema.parse(rawInput);

  const level = await db.$transaction(async (tx) => {
    const item = await loadItemForUpdate(
      tx,
      input.variantId ? { variantId: input.variantId } : { sku: input.sku! },
    );

    const delta = input.delta !== undefined ? input.delta : input.setOnHand! - item.quantityOnHand;
    if (delta === 0) return toLevel(item);

    const nextOnHand = await applyOnHandDeltaTx(
      tx,
      item.id,
      item.quantityOnHand,
      item.quantityReserved,
      delta,
      {
        type: input.type,
        variantId: item.variant.id,
        reason: input.reason,
        reference: input.reference,
        actorId: authed.id,
      },
    );

    return toLevel({ ...item, quantityOnHand: nextOnHand });
  });

  await recordAudit(
    {
      action:
        input.type === StockMovementType.ADJUSTMENT
          ? AUDIT_ACTIONS.INVENTORY_ADJUSTED
          : AUDIT_ACTIONS.INVENTORY_RECEIVED,
      actorUserId: authed.id,
      entityType: "ProductVariant",
      entityId: level.variantId,
      metadata: {
        sku: level.sku,
        movementType: input.type,
        reason: input.reason,
        reference: input.reference ?? null,
        resultingOnHand: level.onHand,
      },
      ipAddress: rawInput.ipAddress,
      userAgent: rawInput.userAgent,
    },
    db,
  );
  return level;
}

/** Set the reorder threshold for a variant's inventory item. */
export async function setReorderLevel(
  actor: Actor,
  variantId: string,
  reorderLevel: number | null,
  db: Db = prisma,
): Promise<InventoryLevel> {
  requirePermission(actor, "inventory.write");
  if (reorderLevel != null && (reorderLevel < 0 || !Number.isInteger(reorderLevel))) {
    throw new InventoryRuleError("Reorder level must be a non-negative integer.");
  }
  const item = await db.inventoryItem.update({
    where: { variantId },
    data: { reorderLevel },
    select: levelSelect,
  });
  return toLevel(item);
}

// ---------------------------------------------------------------------------
// Primitives for the future order flow (transaction-composable)
// ---------------------------------------------------------------------------

export async function reserveStockTx(
  tx: ItemTx,
  variantId: string,
  quantity: number,
  reference: string,
): Promise<void> {
  if (quantity <= 0) throw new InventoryRuleError("Reservation quantity must be positive.");
  const item = await loadItemForUpdate(tx, { variantId });
  const available = item.quantityOnHand - item.quantityReserved;
  if (available < quantity) {
    throw new InventoryRuleError(
      `Only ${available} unit(s) available for ${item.variant.sku}; cannot reserve ${quantity}.`,
    );
  }
  await tx.inventoryItem.update({
    where: { id: item.id },
    data: { quantityReserved: item.quantityReserved + quantity },
  });
  await tx.stockMovement.create({
    data: {
      inventoryItemId: item.id,
      variantId,
      type: StockMovementType.RESERVATION,
      quantityDelta: 0, // on-hand unchanged; reserved increased by `quantity`
      reason: `Reserve ${quantity}`,
      reference,
    },
  });
}

export async function releaseReservationTx(
  tx: ItemTx,
  variantId: string,
  quantity: number,
  reference: string,
): Promise<void> {
  if (quantity <= 0) throw new InventoryRuleError("Release quantity must be positive.");
  const item = await loadItemForUpdate(tx, { variantId });
  const release = Math.min(quantity, item.quantityReserved);
  await tx.inventoryItem.update({
    where: { id: item.id },
    data: { quantityReserved: item.quantityReserved - release },
  });
  await tx.stockMovement.create({
    data: {
      inventoryItemId: item.id,
      variantId,
      type: StockMovementType.RELEASE,
      quantityDelta: 0,
      reason: `Release ${release}`,
      reference,
    },
  });
}

/** Fulfil a reservation: decrement on-hand and reserved together. */
export async function commitReservationTx(
  tx: ItemTx,
  variantId: string,
  quantity: number,
  reference: string,
): Promise<void> {
  if (quantity <= 0) throw new InventoryRuleError("Commit quantity must be positive.");
  const item = await loadItemForUpdate(tx, { variantId });
  if (item.quantityReserved < quantity) {
    throw new InventoryRuleError(
      `Cannot commit ${quantity}; only ${item.quantityReserved} reserved for ${item.variant.sku}.`,
    );
  }
  await tx.inventoryItem.update({
    where: { id: item.id },
    data: {
      quantityOnHand: item.quantityOnHand - quantity,
      quantityReserved: item.quantityReserved - quantity,
    },
  });
  await tx.stockMovement.create({
    data: {
      inventoryItemId: item.id,
      variantId,
      type: StockMovementType.SALE,
      quantityDelta: -quantity,
      reason: `Sale of ${quantity}`,
      reference,
    },
  });
}

/**
 * Set on-hand stock to an absolute target and write the balancing movement.
 * Used by the importer. No-op (returns `false`) when already at the target.
 */
export async function setOnHandTx(
  tx: ItemTx,
  variantId: string,
  targetOnHand: number,
  movement: { type: StockMovementType; reason: string; reference: string; actorId: string | null },
): Promise<boolean> {
  if (targetOnHand < 0) throw new InventoryRuleError("Target quantity must not be negative.");
  const item = await loadItemForUpdate(tx, { variantId });
  const delta = targetOnHand - item.quantityOnHand;
  if (delta === 0) return false;
  await applyOnHandDeltaTx(tx, item.id, item.quantityOnHand, item.quantityReserved, delta, {
    type: movement.type,
    variantId: item.variant.id,
    reason: movement.reason,
    reference: movement.reference,
    actorId: movement.actorId,
  });
  return true;
}

/** Return stock to on-hand (e.g. an order refund). */
export async function restockTx(
  tx: ItemTx,
  variantId: string,
  quantity: number,
  reference: string,
): Promise<void> {
  if (quantity <= 0) throw new InventoryRuleError("Restock quantity must be positive.");
  const item = await loadItemForUpdate(tx, { variantId });
  await tx.inventoryItem.update({
    where: { id: item.id },
    data: { quantityOnHand: item.quantityOnHand + quantity },
  });
  await tx.stockMovement.create({
    data: {
      inventoryItemId: item.id,
      variantId,
      type: StockMovementType.RETURN,
      quantityDelta: quantity,
      reason: `Restock ${quantity}`,
      reference,
    },
  });
}
