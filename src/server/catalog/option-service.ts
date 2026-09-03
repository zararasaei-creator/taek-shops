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
import { productOptionInputSchema } from "@/lib/validation/catalog";
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
 */
export async function ensureOptionValueTx(
  tx: Pick<CatalogTxClient, "productOption" | "productOptionValue">,
  productId: string,
  optionName: string,
  value: string,
): Promise<{ optionId: string; optionValueId: string }> {
  const name = optionName.trim();
  const val = value.trim();
  if (!name || !val) throw new CatalogValidationError("Option name and value are required.");

  const option = await tx.productOption.upsert({
    where: { productId_name: { productId, name } },
    update: {},
    create: { productId, name, position: 0 },
    select: { id: true, _count: { select: { values: true } } },
  });

  const optionValue = await tx.productOptionValue.upsert({
    where: { optionId_value: { optionId: option.id, value: val } },
    update: {},
    create: { optionId: option.id, value: val, position: option._count.values },
    select: { id: true },
  });

  return { optionId: option.id, optionValueId: optionValue.id };
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
