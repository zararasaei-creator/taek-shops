import type { PrismaClient, ProductOption, ProductOptionValue } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { requirePermission, type AuthUser } from "@/server/auth/authorization";
import { recordAudit } from "@/server/audit/audit-service";
import { AUDIT_ACTIONS } from "@/server/audit/actions";
import {
  CatalogValidationError,
  ConflictError,
  NotFoundError,
  ReferentialIntegrityError,
} from "@/server/catalog/errors";
import { extendOptionInputSchema, productOptionInputSchema } from "@/lib/validation/catalog";
import { optionSignature } from "@/server/catalog/option-signature";
import type { CatalogTxClient } from "@/server/catalog/tx";

/**
 * Product option / option-value administration.
 *
 * Options and values that a variant selects cannot be deleted — the operator
 * must delete or re-map those variants first. This protects the
 * `optionSignature` invariant and prevents orphaned selections.
 */

type Db = Pick<PrismaClient, "product" | "productOption" | "productOptionValue" | "auditLog">;
type Actor = AuthUser | null | undefined;

interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function getProductOptions(
  actor: Actor,
  productId: string,
  db: Db = prisma,
): Promise<(ProductOption & { values: ProductOptionValue[] })[]> {
  requirePermission(actor, "catalog.read");
  return db.productOption.findMany({
    where: { productId },
    include: { values: { orderBy: { position: "asc" } } },
    orderBy: { position: "asc" },
  });
}

export async function addProductOption(
  actor: Actor,
  productId: string,
  input: unknown,
  meta: Meta = {},
  db: Db = prisma,
): Promise<ProductOption & { values: ProductOptionValue[] }> {
  const authed = requirePermission(actor, "catalog.write");
  const data = productOptionInputSchema.parse(input);

  const product = await db.product.findUnique({
    where: { id: productId },
    select: { id: true, _count: { select: { variants: true } } },
  });
  if (!product) throw new NotFoundError("Product", productId);
  if (product._count.variants > 0) {
    throw new ReferentialIntegrityError(
      "Add options before creating variants — this product already has variants that would be missing a value for the new option.",
    );
  }

  const clash = await db.productOption.findUnique({
    where: { productId_name: { productId, name: data.name } },
    select: { id: true },
  });
  if (clash) throw new ConflictError(`This product already has an option named "${data.name}".`);

  const uniqueValues = [...new Set(data.values.map((v) => v.trim()))];
  const option = await db.productOption.create({
    data: {
      productId,
      name: data.name,
      position: data.position,
      values: {
        create: uniqueValues.map((value, index) => ({ value, position: index })),
      },
    },
    include: { values: { orderBy: { position: "asc" } } },
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PRODUCT_OPTIONS_CHANGED,
      actorUserId: authed.id,
      entityType: "Product",
      entityId: productId,
      metadata: { added: { option: data.name, values: uniqueValues } },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
    db,
  );
  return option;
}

export async function addOptionValue(
  actor: Actor,
  optionId: string,
  value: string,
  meta: Meta = {},
  db: Db = prisma,
): Promise<ProductOptionValue> {
  const authed = requirePermission(actor, "catalog.write");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80) throw new CatalogValidationError("Invalid option value.");

  const option = await db.productOption.findUnique({
    where: { id: optionId },
    select: { id: true, productId: true, name: true, _count: { select: { values: true } } },
  });
  if (!option) throw new NotFoundError("Product option", optionId);

  const clash = await db.productOptionValue.findUnique({
    where: { optionId_value: { optionId, value: trimmed } },
    select: { id: true },
  });
  if (clash) throw new ConflictError(`"${option.name}" already has the value "${trimmed}".`);

  const created = await db.productOptionValue.create({
    data: { optionId, value: trimmed, position: option._count.values },
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PRODUCT_OPTIONS_CHANGED,
      actorUserId: authed.id,
      entityType: "Product",
      entityId: option.productId,
      metadata: { addedValue: { option: option.name, value: trimmed } },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
    db,
  );
  return created;
}

export async function removeOptionValue(
  actor: Actor,
  optionValueId: string,
  meta: Meta = {},
  db: Db = prisma,
): Promise<void> {
  const authed = requirePermission(actor, "catalog.write");
  const value = await db.productOptionValue.findUnique({
    where: { id: optionValueId },
    select: {
      id: true,
      value: true,
      option: { select: { productId: true, name: true } },
      _count: { select: { variantSelections: true } },
    },
  });
  if (!value) throw new NotFoundError("Option value", optionValueId);
  if (value._count.variantSelections > 0) {
    throw new ReferentialIntegrityError(
      `"${value.value}" is used by ${value._count.variantSelections} variant(s). Remove or re-map those variants first.`,
    );
  }

  await db.productOptionValue.delete({ where: { id: optionValueId } });
  await recordAudit(
    {
      action: AUDIT_ACTIONS.PRODUCT_OPTIONS_CHANGED,
      actorUserId: authed.id,
      entityType: "Product",
      entityId: value.option.productId,
      metadata: { removedValue: { option: value.option.name, value: value.value } },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
    db,
  );
}

export async function removeProductOption(
  actor: Actor,
  optionId: string,
  meta: Meta = {},
  db: Db = prisma,
): Promise<void> {
  const authed = requirePermission(actor, "catalog.write");
  const option = await db.productOption.findUnique({
    where: { id: optionId },
    select: {
      id: true,
      name: true,
      productId: true,
      _count: { select: { variantSelections: true } },
    },
  });
  if (!option) throw new NotFoundError("Product option", optionId);
  if (option._count.variantSelections > 0) {
    throw new ReferentialIntegrityError(
      `Option "${option.name}" is used by existing variants. Remove those variants first.`,
    );
  }

  await db.productOption.delete({ where: { id: optionId } }); // cascades to its values
  await recordAudit(
    {
      action: AUDIT_ACTIONS.PRODUCT_OPTIONS_CHANGED,
      actorUserId: authed.id,
      entityType: "Product",
      entityId: option.productId,
      metadata: { removedOption: option.name },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
    db,
  );
}

/**
 * Find-or-create an option value for a product, by option name + value. Used by
 * the importer and by variant creation so a spreadsheet / form can reference
 * options declaratively. Runs inside the caller's transaction.
 *
 * `allowNewOption` (default `true`) gates whether a brand-new `ProductOption`
 * may be created here. Callers that are adding a variant to a product that
 * already has OTHER variants must pass `false` — creating a new option
 * implicitly, mid variant-creation, would leave every sibling variant without a
 * value for it. Those callers should point the operator at
 * `extendProductOption`, which adds the option atomically with a required
 * backfill value for every existing variant. A NEW option value on an option
 * that already exists is always safe (siblings already have some value for
 * that option) and is never gated.
 */
export async function ensureOptionValueTx(
  tx: Pick<CatalogTxClient, "productOption" | "productOptionValue">,
  productId: string,
  optionName: string,
  value: string,
  opts: { allowNewOption: boolean } = { allowNewOption: true },
): Promise<{ optionId: string; optionValueId: string }> {
  const name = optionName.trim();
  const val = value.trim();
  if (!name || !val) throw new CatalogValidationError("Option name and value are required.");

  const existingOption = await tx.productOption.findUnique({
    where: { productId_name: { productId, name } },
    select: { id: true, _count: { select: { values: true } } },
  });

  if (!existingOption && !opts.allowNewOption) {
    throw new ReferentialIntegrityError(
      `Option "${name}" does not exist on this product yet. This product already has variants, so ` +
        `adding a new option requires the "extend options" operation, which backfills a value for ` +
        `every existing variant.`,
    );
  }

  const option =
    existingOption ??
    (await tx.productOption.create({
      data: { productId, name, position: 0 },
      select: { id: true, _count: { select: { values: true } } },
    }));

  const optionValue = await tx.productOptionValue.upsert({
    where: { optionId_value: { optionId: option.id, value: val } },
    update: {},
    create: { optionId: option.id, value: val, position: option._count.values },
    select: { id: true },
  });

  return { optionId: option.id, optionValueId: optionValue.id };
}

/**
 * Add a brand-new option to a product that may already have variants. If it
 * does, `backfill` must supply exactly one of the new `values` for every
 * existing variant — every variant's `optionSignature` is recomputed and
 * checked for uniqueness in the SAME transaction as the option/value rows, so
 * the whole operation is atomic: either every variant ends up with a value for
 * the new option, or nothing changes.
 */
export async function extendProductOption(
  actor: Actor,
  productId: string,
  input: unknown,
  meta: Meta = {},
  db: PrismaClient = prisma,
): Promise<ProductOption & { values: ProductOptionValue[] }> {
  const authed = requirePermission(actor, "catalog.write");
  const data = extendOptionInputSchema.parse(input);

  const uniqueValues = [...new Set(data.values.map((v) => v.trim()))];
  if (uniqueValues.length !== data.values.length) {
    throw new CatalogValidationError("Duplicate option values are not allowed.");
  }

  const option = await db.$transaction(async (tx) => {
    const product = await tx.product.findUnique({
      where: { id: productId },
      select: { id: true },
    });
    if (!product) throw new NotFoundError("Product", productId);

    const clash = await tx.productOption.findUnique({
      where: { productId_name: { productId, name: data.name } },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictError(
        `This product already has an option named "${data.name}". Use addOptionValue to add ` +
          `values to it instead.`,
      );
    }

    const existingVariants = await tx.productVariant.findMany({
      where: { productId },
      select: {
        id: true,
        optionValues: { select: { optionValueId: true } },
      },
    });

    const backfillByVariant = new Map(data.backfill.map((b) => [b.variantId, b.value.trim()]));

    if (existingVariants.length > 0) {
      const existingIds = new Set(existingVariants.map((v) => v.id));

      const missing = existingVariants.filter((v) => !backfillByVariant.has(v.id));
      if (missing.length > 0) {
        throw new CatalogValidationError(
          `A backfill value is required for every existing variant. Missing backfill for: ` +
            `${missing.map((v) => v.id).join(", ")}.`,
        );
      }
      const extra = data.backfill.filter((b) => !existingIds.has(b.variantId));
      if (extra.length > 0) {
        throw new CatalogValidationError(
          `Backfill references variant(s) that do not belong to this product: ` +
            `${extra.map((b) => b.variantId).join(", ")}.`,
        );
      }
      for (const value of backfillByVariant.values()) {
        if (!uniqueValues.includes(value)) {
          throw new CatalogValidationError(
            `Backfill value "${value}" must be one of the values being added: ${uniqueValues.join(", ")}.`,
          );
        }
      }
    } else if (data.backfill.length > 0) {
      throw new CatalogValidationError(
        "This product has no variants yet; backfill is not applicable.",
      );
    }

    const created = await tx.productOption.create({
      data: {
        productId,
        name: data.name,
        position: data.position,
        values: { create: uniqueValues.map((value, index) => ({ value, position: index })) },
      },
      include: { values: { orderBy: { position: "asc" } } },
    });

    if (existingVariants.length > 0) {
      const valueIdByValue = new Map(created.values.map((v) => [v.value, v.id]));
      const seenSignatures = new Set<string>();

      for (const variant of existingVariants) {
        const backfillValue = backfillByVariant.get(variant.id)!;
        const optionValueId = valueIdByValue.get(backfillValue)!;

        await tx.productVariantOptionValue.create({
          data: { variantId: variant.id, optionId: created.id, optionValueId },
        });

        const nextSignature = optionSignature([
          ...variant.optionValues.map((ov) => ov.optionValueId),
          optionValueId,
        ]);
        if (seenSignatures.has(nextSignature)) {
          throw new ConflictError(
            "Backfilling would create two variants with the same option combination.",
          );
        }
        seenSignatures.add(nextSignature);

        await tx.productVariant.update({
          where: { id: variant.id },
          data: { optionSignature: nextSignature },
        });
      }
    }

    return created;
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PRODUCT_OPTION_EXTENDED,
      actorUserId: authed.id,
      entityType: "Product",
      entityId: productId,
      metadata: {
        option: data.name,
        values: uniqueValues,
        backfilledVariants: data.backfill.length,
      },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
    db,
  );
  return option;
}

/** Resolve an option name + value pair to its optionValueId for a product (read-only). */
export async function resolveOptionValue(
  db: Pick<PrismaClient, "productOption">,
  productId: string,
  optionName: string,
  value: string,
): Promise<{ optionId: string; optionValueId: string } | null> {
  const option = await db.productOption.findUnique({
    where: { productId_name: { productId, name: optionName.trim() } },
    select: { id: true, values: { where: { value: value.trim() }, select: { id: true } } },
  });
  const match = option?.values[0];
  return option && match ? { optionId: option.id, optionValueId: match.id } : null;
}
