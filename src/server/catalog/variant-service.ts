import type { Prisma, PrismaClient, ProductVariant } from "@prisma/client";
import { StockMovementType } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { requirePermission, type AuthUser } from "@/server/auth/authorization";
import { recordAudit } from "@/server/audit/audit-service";
import { AUDIT_ACTIONS } from "@/server/audit/actions";
import { CatalogValidationError, ConflictError, NotFoundError } from "@/server/catalog/errors";
import { optionSignature } from "@/server/catalog/option-signature";
import { ensureOptionValueTx } from "@/server/catalog/option-service";
import type { CatalogTxClient } from "@/server/catalog/tx";
import {
  matrixGenerateSchema,
  variantCreateSchema,
  variantUpdateSchema,
  type MatrixCellInput,
  type VariantCreateInput,
  type VariantUpdateInput,
} from "@/lib/validation/catalog";
import { comboKey } from "@/lib/catalog/variant-matrix";

/**
 * Variant administration.
 *
 * Invariants enforced (application + DB):
 * - `sku` unique (DB `@unique`);
 * - a variant selects exactly one value per product option, and every product
 *   option is covered;
 * - no two variants of a product share an option combination
 *   (`optionSignature` + DB `@@unique([productId, optionSignature])`);
 * - each variant has exactly one `InventoryItem`.
 */

type Db = PrismaClient;
type Actor = AuthUser | null | undefined;

interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

async function assertSkuFree(
  tx: Pick<CatalogTxClient, "productVariant">,
  sku: string,
  exceptId?: string,
): Promise<void> {
  const existing = await tx.productVariant.findUnique({ where: { sku }, select: { id: true } });
  if (existing && existing.id !== exceptId) {
    throw new ConflictError(`SKU "${sku}" is already in use.`);
  }
}

async function assertBarcodeFree(
  tx: Pick<CatalogTxClient, "productVariant">,
  barcode: string,
  exceptId?: string,
): Promise<void> {
  const existing = await tx.productVariant.findUnique({ where: { barcode }, select: { id: true } });
  if (existing && existing.id !== exceptId) {
    throw new ConflictError(`Barcode "${barcode}" is already in use.`);
  }
}

/**
 * Resolve the caller's `{ option, value }` selections to optionValue ids for the
 * product, creating options/values as needed, then verify every product option
 * is covered exactly once. Returns the ids and the resulting signature.
 *
 * `exceptVariantId` (set when re-mapping an existing variant's selections) is
 * excluded when counting the product's other variants: a product's introducing
 * a brand-new option is only auto-allowed when there are no OTHER variants that
 * would end up missing a value for it. Otherwise use `extendProductOption`.
 */
async function resolveSelections(
  tx: Pick<CatalogTxClient, "productOption" | "productOptionValue" | "productVariant">,
  productId: string,
  selections: { option: string; value: string }[],
  exceptVariantId?: string,
): Promise<{
  optionValueIds: string[];
  joinRows: { optionId: string; optionValueId: string }[];
  signature: string;
}> {
  const otherVariantCount = await tx.productVariant.count({
    where: { productId, ...(exceptVariantId ? { id: { not: exceptVariantId } } : {}) },
  });
  const allowNewOption = otherVariantCount === 0;

  const seenOptionNames = new Set<string>();
  const joinRows: { optionId: string; optionValueId: string }[] = [];

  for (const selection of selections) {
    const key = selection.option.trim().toLowerCase();
    if (seenOptionNames.has(key)) {
      throw new CatalogValidationError(`Option "${selection.option}" is specified more than once.`);
    }
    seenOptionNames.add(key);
    const { optionId, optionValueId } = await ensureOptionValueTx(
      tx,
      productId,
      selection.option,
      selection.value,
      { allowNewOption },
    );
    joinRows.push({ optionId, optionValueId });
  }

  const productOptions = await tx.productOption.findMany({
    where: { productId },
    select: { id: true, name: true },
  });
  const coveredOptionIds = new Set(joinRows.map((r) => r.optionId));
  const missing = productOptions.filter((o) => !coveredOptionIds.has(o.id));
  if (missing.length > 0) {
    throw new CatalogValidationError(
      `This variant is missing a value for option(s): ${missing.map((o) => o.name).join(", ")}.`,
    );
  }

  const optionValueIds = joinRows.map((r) => r.optionValueId);
  return { optionValueIds, joinRows, signature: optionSignature(optionValueIds) };
}

async function assertSignatureFree(
  tx: Pick<CatalogTxClient, "productVariant">,
  productId: string,
  signature: string,
  exceptId?: string,
): Promise<void> {
  const existing = await tx.productVariant.findUnique({
    where: { productId_optionSignature: { productId, optionSignature: signature } },
    select: { id: true },
  });
  if (existing && existing.id !== exceptId) {
    throw new ConflictError(
      "A variant with this option combination already exists for this product.",
    );
  }
}

/**
 * Create a variant inside an existing transaction. Does NOT check authorization
 * or write a top-level audit event — the calling service owns those.
 */
export async function createVariantTx(
  tx: CatalogTxClient,
  productId: string,
  rawInput: VariantCreateInput,
  actorId: string | null,
): Promise<ProductVariant> {
  const input = variantCreateSchema.parse(rawInput);

  const product = await tx.product.findUnique({ where: { id: productId }, select: { id: true } });
  if (!product) throw new NotFoundError("Product", productId);

  await assertSkuFree(tx, input.sku);
  if (input.barcode) await assertBarcodeFree(tx, input.barcode);

  const { joinRows, signature } = await resolveSelections(tx, productId, input.optionSelections);
  await assertSignatureFree(tx, productId, signature);

  if (input.compareAtPriceCents !== undefined && input.compareAtPriceCents <= input.priceCents) {
    throw new CatalogValidationError("Compare-at price must be greater than the selling price.");
  }

  const variant = await tx.productVariant.create({
    data: {
      productId,
      sku: input.sku,
      barcode: input.barcode ?? null,
      name: input.name ?? null,
      position: input.position,
      priceCents: input.priceCents,
      compareAtPriceCents: input.compareAtPriceCents ?? null,
      costCents: input.costCents ?? null,
      weightGrams: input.weightGrams ?? null,
      active: input.active,
      trackInventory: input.trackInventory,
      optionSignature: signature,
      optionValues: {
        create: joinRows.map((r) => ({
          option: { connect: { id: r.optionId } },
          optionValue: { connect: { id: r.optionValueId } },
        })),
      },
      inventoryItem: {
        create: { quantityOnHand: input.initialQuantity, quantityReserved: 0 },
      },
    },
    include: { inventoryItem: true },
  });

  if (input.initialQuantity > 0 && variant.inventoryItem) {
    await tx.stockMovement.create({
      data: {
        inventoryItemId: variant.inventoryItem.id,
        variantId: variant.id,
        type: StockMovementType.INITIAL,
        quantityDelta: input.initialQuantity,
        reason: "Opening balance",
        actorId,
      },
    });
  }

  return variant;
}

export async function createVariant(
  actor: Actor,
  productId: string,
  input: VariantCreateInput & Meta,
  db: Db = prisma,
): Promise<ProductVariant> {
  const authed = requirePermission(actor, "catalog.write");

  const variant = await db.$transaction((tx) => createVariantTx(tx, productId, input, authed.id));

  await recordAudit(
    {
      action: AUDIT_ACTIONS.VARIANT_CREATED,
      actorUserId: authed.id,
      entityType: "ProductVariant",
      entityId: variant.id,
      metadata: { productId, sku: variant.sku, priceCents: variant.priceCents },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
    db,
  );
  return variant;
}

export async function updateVariant(
  actor: Actor,
  variantId: string,
  input: VariantUpdateInput & Meta,
  db: Db = prisma,
): Promise<ProductVariant> {
  const authed = requirePermission(actor, "catalog.write");
  const data = variantUpdateSchema.parse(input);

  const { variant, priceChanged, oldPrice } = await db.$transaction(async (tx) => {
    const current = await tx.productVariant.findUnique({ where: { id: variantId } });
    if (!current) throw new NotFoundError("Variant", variantId);

    if (data.sku !== undefined && data.sku !== current.sku)
      await assertSkuFree(tx, data.sku, variantId);
    if (data.barcode) await assertBarcodeFree(tx, data.barcode, variantId);

    const patch: Prisma.ProductVariantUpdateInput = {
      ...(data.sku !== undefined ? { sku: data.sku } : {}),
      ...(data.barcode !== undefined ? { barcode: data.barcode || null } : {}),
      ...(data.name !== undefined ? { name: data.name || null } : {}),
      ...(data.position !== undefined ? { position: data.position } : {}),
      ...(data.priceCents !== undefined ? { priceCents: data.priceCents } : {}),
      ...(data.compareAtPriceCents !== undefined
        ? { compareAtPriceCents: data.compareAtPriceCents ?? null }
        : {}),
      ...(data.costCents !== undefined ? { costCents: data.costCents ?? null } : {}),
      ...(data.weightGrams !== undefined ? { weightGrams: data.weightGrams ?? null } : {}),
      ...(data.active !== undefined ? { active: data.active } : {}),
      ...(data.trackInventory !== undefined ? { trackInventory: data.trackInventory } : {}),
    };

    const nextPrice = data.priceCents ?? current.priceCents;
    const nextCompare =
      data.compareAtPriceCents !== undefined
        ? data.compareAtPriceCents
        : current.compareAtPriceCents;
    if (nextCompare != null && nextCompare <= nextPrice) {
      throw new CatalogValidationError("Compare-at price must be greater than the selling price.");
    }

    // Re-map option selections (rare; changes the signature).
    if (data.optionSelections !== undefined) {
      const { joinRows, signature } = await resolveSelections(
        tx,
        current.productId,
        data.optionSelections,
        variantId,
      );
      await assertSignatureFree(tx, current.productId, signature, variantId);
      await tx.productVariantOptionValue.deleteMany({ where: { variantId } });
      await tx.productVariantOptionValue.createMany({
        data: joinRows.map((r) => ({
          variantId,
          optionId: r.optionId,
          optionValueId: r.optionValueId,
        })),
      });
      patch.optionSignature = signature;
    }

    const updated = await tx.productVariant.update({ where: { id: variantId }, data: patch });
    return {
      variant: updated,
      priceChanged: data.priceCents !== undefined && data.priceCents !== current.priceCents,
      oldPrice: current.priceCents,
    };
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.VARIANT_UPDATED,
      actorUserId: authed.id,
      entityType: "ProductVariant",
      entityId: variantId,
      metadata: { fields: Object.keys(data) },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
    db,
  );

  if (priceChanged) {
    await recordAudit(
      {
        action: AUDIT_ACTIONS.VARIANT_PRICE_CHANGED,
        actorUserId: authed.id,
        entityType: "ProductVariant",
        entityId: variantId,
        metadata: { fromCents: oldPrice, toCents: variant.priceCents },
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      },
      db,
    );
  }
  return variant;
}

export async function archiveVariant(
  actor: Actor,
  variantId: string,
  meta: Meta = {},
  db: Db = prisma,
): Promise<ProductVariant> {
  const authed = requirePermission(actor, "catalog.write");
  const variant = await db.productVariant.findUnique({
    where: { id: variantId },
    select: { id: true, _count: { select: { orderItems: true } } },
  });
  if (!variant) throw new NotFoundError("Variant", variantId);

  const updated = await db.productVariant.update({
    where: { id: variantId },
    data: { active: false },
  });
  await recordAudit(
    {
      action: AUDIT_ACTIONS.VARIANT_ARCHIVED,
      actorUserId: authed.id,
      entityType: "ProductVariant",
      entityId: variantId,
      metadata: { orderReferences: variant._count.orderItems },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
    db,
  );
  return updated;
}

/**
 * Bulk-create variants for the admin Variant Matrix Generator: every cell is
 * created via `createVariantTx` inside ONE transaction, so the whole batch
 * commits or none of it does. Each cell already names its own option
 * selections by (existing) option/value name, exactly like a single
 * `createVariant` call — the matrix generator only ever offers option values
 * that already exist on the product, so this never implicitly creates a new
 * option (use `extendProductOption` for that).
 *
 * Duplicate SKUs and duplicate option combinations *within the batch* are
 * rejected up front (a proxy signature from the raw option/value names, since
 * real ids aren't known until each cell resolves inside the transaction) so a
 * bad batch fails with one clear, complete error instead of failing on
 * whichever cell happens to collide first. Collisions against variants that
 * already exist in the database are still caught by `createVariantTx` itself.
 */
export async function generateVariantMatrix(
  actor: Actor,
  productId: string,
  input: { cells: unknown[] } & Meta,
  db: Db = prisma,
): Promise<ProductVariant[]> {
  const authed = requirePermission(actor, "catalog.write");
  const { cells } = matrixGenerateSchema.parse(input);

  const skuCounts = new Map<string, number>();
  const comboCounts = new Map<string, number>();
  for (const cell of cells) {
    skuCounts.set(cell.sku, (skuCounts.get(cell.sku) ?? 0) + 1);
    const key = comboKey(
      cell.optionSelections.map((s) => ({ optionName: s.option, value: s.value })),
    );
    comboCounts.set(key, (comboCounts.get(key) ?? 0) + 1);
  }
  const dupeSkus = [...skuCounts.entries()].filter(([, n]) => n > 1).map(([sku]) => sku);
  if (dupeSkus.length > 0) {
    throw new ConflictError(`Duplicate SKU(s) within this batch: ${dupeSkus.join(", ")}.`);
  }
  const dupeCombos = [...comboCounts.entries()].filter(([, n]) => n > 1).length;
  if (dupeCombos > 0) {
    throw new ConflictError(
      `${dupeCombos} option combination(s) are repeated more than once within this batch.`,
    );
  }

  const variants = await db.$transaction(async (tx) => {
    const created: ProductVariant[] = [];
    for (const cell of cells as MatrixCellInput[]) {
      created.push(await createVariantTx(tx, productId, cell, authed.id));
    }
    return created;
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.VARIANT_MATRIX_GENERATED,
      actorUserId: authed.id,
      entityType: "Product",
      entityId: productId,
      metadata: { count: variants.length, skus: variants.map((v) => v.sku) },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
    db,
  );
  return variants;
}
