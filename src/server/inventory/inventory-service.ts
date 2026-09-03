import { StockMovementType, type Prisma, type PrismaClient } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { requirePermission, type AuthUser } from "@/server/auth/authorization";
import { recordAudit } from "@/server/audit/audit-service";
import { AUDIT_ACTIONS } from "@/server/audit/actions";
import { InventoryRuleError, NotFoundError } from "@/server/catalog/errors";
import { inventoryAdjustSchema, type InventoryAdjustInput } from "@/lib/validation/catalog";
import {
  lockInventoryItem,
  movementExists,
  type InventoryTx,
  type LockedInventoryItem,
} from "@/server/inventory/inventory-lock";

/**
 * The single controlled entry point for stock changes.
 *
 * Rules (never silently violated — enforced in this module AND by CHECK
 * constraints on `InventoryItem`):
 * - `quantityOnHand` is never negative;
 * - `quantityReserved` is never negative;
 * - `quantityOnHand` is never dropped below `quantityReserved` (that would make
 *   an existing reservation unfulfillable);
 * - every change writes an append-only `StockMovement` in the same transaction
 *   as the counter update, carrying the signed `quantityDelta` (on-hand) and
 *   `reservedDelta` (reserved) so both counters reconcile against the ledger;
 * - `available = quantityOnHand - quantityReserved` is derived, never stored.
 *
 * Concurrency: every mutation opens a transaction and takes a `FOR UPDATE` row
 * lock on the `InventoryItem` (`lockInventoryItem`) before reading counters, so
 * parallel writers to the same variant serialize and cannot oversell.
 *
 * Order placement / cancellation call `reserveStockTx` / `releaseReservationTx` /
 * `commitReservationTx` / `restockTx` — the same primitives, wired up in
 * `src/server/orders/order-inventory.ts`.
 */

type Db = PrismaClient;
type Actor = AuthUser | null | undefined;

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

function levelFromCounters(
  item: Pick<LockedInventoryItem, "id" | "variantId" | "sku" | "reorderLevel">,
  onHand: number,
  reserved: number,
): InventoryLevel {
  const available = onHand - reserved;
  return {
    variantId: item.variantId,
    sku: item.sku,
    inventoryItemId: item.id,
    onHand,
    reserved,
    available,
    reorderLevel: item.reorderLevel,
    belowReorderLevel: item.reorderLevel != null && available <= item.reorderLevel,
  };
}

function toLevel(row: {
  id: string;
  quantityOnHand: number;
  quantityReserved: number;
  reorderLevel: number | null;
  variant: { id: string; sku: string };
}): InventoryLevel {
  return levelFromCounters(
    { id: row.id, variantId: row.variant.id, sku: row.variant.sku, reorderLevel: row.reorderLevel },
    row.quantityOnHand,
    row.quantityReserved,
  );
}

const levelSelect = {
  id: true,
  quantityOnHand: true,
  quantityReserved: true,
  reorderLevel: true,
  variant: { select: { id: true, sku: true } },
} satisfies Prisma.InventoryItemSelect;

/** Resolve a `{ sku }` or `{ variantId }` selector to a variant id. */
async function resolveVariantId(
  tx: Pick<InventoryTx, "productVariant">,
  where: { variantId: string } | { sku: string },
): Promise<string> {
  if ("variantId" in where) return where.variantId;
  const variant = await tx.productVariant.findUnique({
    where: { sku: where.sku },
    select: { id: true },
  });
  if (!variant) throw new NotFoundError("Variant", where.sku);
  return variant.id;
}

export interface MovementSpec {
  type: StockMovementType;
  /** Signed change to on-hand. */
  quantityDelta: number;
  /** Signed change to reserved. */
  reservedDelta: number;
  reason: string;
  reference?: string | null;
  actorId?: string | null;
  idempotencyKey?: string | null;
}

/**
 * Apply the counter changes described by `spec` to a locked inventory item and
 * append the matching `StockMovement`, enforcing every hard rule. Assumes the
 * caller already holds the `FOR UPDATE` lock on `item`.
 */
async function applyMovementTx(
  tx: Pick<InventoryTx, "inventoryItem" | "stockMovement">,
  item: LockedInventoryItem,
  spec: MovementSpec,
): Promise<{ onHand: number; reserved: number }> {
  const nextOnHand = item.quantityOnHand + spec.quantityDelta;
  const nextReserved = item.quantityReserved + spec.reservedDelta;

  if (nextOnHand < 0) {
    throw new InventoryRuleError(
      `Change would make on-hand stock negative (${item.quantityOnHand} -> ${nextOnHand}) for ${item.sku}.`,
    );
  }
  if (nextReserved < 0) {
    throw new InventoryRuleError(
      `Change would make reserved stock negative (${item.quantityReserved} -> ${nextReserved}) for ${item.sku}.`,
    );
  }
  if (nextReserved > nextOnHand) {
    throw new InventoryRuleError(
      `Change would leave ${nextReserved} reserved unit(s) unfulfillable (on-hand ${nextOnHand}) for ${item.sku}.`,
    );
  }

  await tx.inventoryItem.update({
    where: { id: item.id },
    data: { quantityOnHand: nextOnHand, quantityReserved: nextReserved },
  });
  await tx.stockMovement.create({
    data: {
      inventoryItemId: item.id,
      variantId: item.variantId,
      type: spec.type,
      quantityDelta: spec.quantityDelta,
      reservedDelta: spec.reservedDelta,
      reason: spec.reason,
      reference: spec.reference ?? null,
      actorId: spec.actorId ?? null,
      idempotencyKey: spec.idempotencyKey ?? null,
    },
  });

  return { onHand: nextOnHand, reserved: nextReserved };
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
      reservedDelta: true;
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
      reservedDelta: true,
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
    const variantId = await resolveVariantId(
      tx,
      input.variantId ? { variantId: input.variantId } : { sku: input.sku! },
    );
    const item = await lockInventoryItem(tx, variantId);

    const delta = input.delta !== undefined ? input.delta : input.setOnHand! - item.quantityOnHand;
    if (delta === 0) {
      return levelFromCounters(item, item.quantityOnHand, item.quantityReserved);
    }

    const { onHand, reserved } = await applyMovementTx(tx, item, {
      type: input.type,
      quantityDelta: delta,
      reservedDelta: 0,
      reason: input.reason,
      reference: input.reference,
      actorId: authed.id,
    });
    return levelFromCounters(item, onHand, reserved);
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
// Primitives for the order flow (transaction-composable)
//
// Each takes a transaction client, locks the row, enforces the rules, and
// appends one movement. `idempotencyKey`, when supplied, makes the call a no-op
// if a movement with that key already exists (safe replay for the order
// lifecycle). Callers must already be inside `db.$transaction(...)`.
// ---------------------------------------------------------------------------

/** Increase `quantityReserved` after checking availability. */
export async function reserveStockTx(
  tx: InventoryTx,
  variantId: string,
  quantity: number,
  reference: string,
  idempotencyKey?: string,
): Promise<void> {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new InventoryRuleError("Reservation quantity must be a positive integer.");
  }
  const item = await lockInventoryItem(tx, variantId);
  if (idempotencyKey && (await movementExists(tx, idempotencyKey))) return;

  const available = item.quantityOnHand - item.quantityReserved;
  if (available < quantity) {
    throw new InventoryRuleError(
      `Only ${available} unit(s) available for ${item.sku}; cannot reserve ${quantity}.`,
    );
  }
  await applyMovementTx(tx, item, {
    type: StockMovementType.RESERVATION,
    quantityDelta: 0,
    reservedDelta: quantity,
    reason: `Reserve ${quantity}`,
    reference,
    idempotencyKey,
  });
}

/** Decrease `quantityReserved` (clamped to what is reserved). */
export async function releaseReservationTx(
  tx: InventoryTx,
  variantId: string,
  quantity: number,
  reference: string,
  idempotencyKey?: string,
): Promise<void> {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new InventoryRuleError("Release quantity must be a positive integer.");
  }
  const item = await lockInventoryItem(tx, variantId);
  if (idempotencyKey && (await movementExists(tx, idempotencyKey))) return;

  const release = Math.min(quantity, item.quantityReserved);
  if (release === 0) return;
  await applyMovementTx(tx, item, {
    type: StockMovementType.RELEASE,
    quantityDelta: 0,
    reservedDelta: -release,
    reason: `Release ${release}`,
    reference,
    idempotencyKey,
  });
}

/** Fulfil a reservation: decrement on-hand and reserved together. */
export async function commitReservationTx(
  tx: InventoryTx,
  variantId: string,
  quantity: number,
  reference: string,
  idempotencyKey?: string,
): Promise<void> {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new InventoryRuleError("Commit quantity must be a positive integer.");
  }
  const item = await lockInventoryItem(tx, variantId);
  if (idempotencyKey && (await movementExists(tx, idempotencyKey))) return;

  if (item.quantityReserved < quantity) {
    throw new InventoryRuleError(
      `Cannot commit ${quantity}; only ${item.quantityReserved} reserved for ${item.sku}.`,
    );
  }
  await applyMovementTx(tx, item, {
    type: StockMovementType.SALE,
    quantityDelta: -quantity,
    reservedDelta: -quantity,
    reason: `Sale of ${quantity}`,
    reference,
    idempotencyKey,
  });
}

/**
 * Set on-hand stock to an absolute target and write the balancing movement.
 * Used by the importer. No-op (returns `false`) when already at the target.
 */
export async function setOnHandTx(
  tx: InventoryTx,
  variantId: string,
  targetOnHand: number,
  movement: {
    type: StockMovementType;
    reason: string;
    reference: string;
    actorId: string | null;
    idempotencyKey?: string;
  },
): Promise<boolean> {
  if (!Number.isInteger(targetOnHand) || targetOnHand < 0) {
    throw new InventoryRuleError("Target quantity must be a non-negative integer.");
  }
  const item = await lockInventoryItem(tx, variantId);
  if (movement.idempotencyKey && (await movementExists(tx, movement.idempotencyKey))) return false;

  const delta = targetOnHand - item.quantityOnHand;
  if (delta === 0) return false;
  await applyMovementTx(tx, item, {
    type: movement.type,
    quantityDelta: delta,
    reservedDelta: 0,
    reason: movement.reason,
    reference: movement.reference,
    actorId: movement.actorId,
    idempotencyKey: movement.idempotencyKey,
  });
  return true;
}

/** Return stock to on-hand (e.g. an order refund / return). */
export async function restockTx(
  tx: InventoryTx,
  variantId: string,
  quantity: number,
  reference: string,
  idempotencyKey?: string,
): Promise<void> {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new InventoryRuleError("Restock quantity must be a positive integer.");
  }
  const item = await lockInventoryItem(tx, variantId);
  if (idempotencyKey && (await movementExists(tx, idempotencyKey))) return;

  await applyMovementTx(tx, item, {
    type: StockMovementType.RETURN,
    quantityDelta: quantity,
    reservedDelta: 0,
    reason: `Restock ${quantity}`,
    reference,
    idempotencyKey,
  });
}
