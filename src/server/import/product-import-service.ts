import { createHash } from "node:crypto";

import {
  ImportJobStatus,
  ImportRowStatus,
  Prisma,
  ProductStatus,
  StockMovementType,
  type PrismaClient,
} from "@prisma/client";

import { prisma } from "@/server/db/client";
import { requirePermission, type AuthUser } from "@/server/auth/authorization";
import { recordAudit } from "@/server/audit/audit-service";
import { AUDIT_ACTIONS } from "@/server/audit/actions";
import { normalizeSlug } from "@/server/catalog/slug";
import { optionSignature } from "@/server/catalog/option-signature";
import { ensureOptionValueTx } from "@/server/catalog/option-service";
import { setOnHandTx } from "@/server/inventory/inventory-service";
import type { CatalogTxClient } from "@/server/catalog/tx";
import { ImportFileError, type RowError } from "@/server/import/errors";
import { type ParsedRow } from "@/server/import/csv-parser";
import { resolveRowSource } from "@/server/import/row-source";
import {
  KNOWN_IMPORT_COLUMNS,
  REQUIRED_IMPORT_COLUMNS,
} from "@/server/import/product-import-columns";
import { parseProductRow, type NormalizedProductRow } from "@/server/import/product-import-schema";

/**
 * Product-import pipeline (CSV, Phase 4).
 *
 * `previewImport` parses + validates + classifies and persists an `ImportJob`
 * with one `ImportJobRow` per input row. It performs NO catalogue writes.
 *
 * `commitImport` re-validates every staged row (spreadsheet content can never
 * bypass server-side validation) and applies it in a per-row transaction —
 * a failing row rolls itself back and is reported; the rest continue. Upsert is
 * keyed on SKU (variant) and slug (product), so re-running the same file is a
 * no-op.
 */

type Db = PrismaClient;
type Actor = AuthUser | null | undefined;

type RowAction = "create" | "update" | "error";

export interface PreviewRow {
  rowNumber: number;
  sku: string | null;
  action: RowAction;
  errors: RowError[];
  warnings: string[];
  summary: string;
}

export interface ImportPreview {
  importJobId: string;
  fileHash: string;
  filename: string;
  totalRows: number;
  counts: { create: number; update: number; error: number };
  unknownColumns: string[];
  fileWarnings: string[];
  rows: PreviewRow[];
}

export interface ImportCommitResult {
  importJobId: string;
  status: ImportJobStatus;
  counts: { created: number; updated: number; skipped: number; failed: number };
  failedRows: { rowNumber: number; sku: string | null; errors: RowError[] }[];
}

interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

const CELL_VALUES_KEY = "raw";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// Preview (dry-run)
// ---------------------------------------------------------------------------

export async function previewImport(
  actor: Actor,
  file: { filename: string; bytes: Uint8Array; contentType?: string | null } & Meta,
  db: Db = prisma,
): Promise<ImportPreview> {
  const authed = requirePermission(actor, "import.run");
  const fileHash = sha256(file.bytes);
  const rowSource = resolveRowSource(file.filename, file.contentType);
  const table = await rowSource.parse(file.bytes, fileHash);

  const missingRequired = REQUIRED_IMPORT_COLUMNS.filter((c) => !table.columns.includes(c));
  if (missingRequired.length > 0) {
    throw new ImportFileError(
      "missing_required_columns",
      `Missing required column(s): ${missingRequired.join(", ")}.`,
    );
  }
  const unknownColumns = table.columns.filter((c) => !KNOWN_IMPORT_COLUMNS.includes(c));

  const existingSkus = await lookupExistingSkus(
    db,
    table.rows.map((r) => (r.values.sku ?? "").trim()).filter(Boolean),
  );

  const seenSkus = new Map<string, number>();
  const productNameBySlug = new Map<string, string>();
  const catalogCache = new Map<string, ExistingProductShape | null>();
  const previewRows: PreviewRow[] = [];
  const stagedRows: {
    rowNumber: number;
    sku: string | null;
    action: ImportRowStatus;
    actionLabel: RowAction;
    errors: RowError[];
    raw: Record<string, string>;
    normalized: NormalizedProductRow | null;
  }[] = [];

  for (const row of table.rows) {
    const { data, errors: schemaErrors } = parseProductRow(row.values);
    // A `RowSource`-level hard failure (currently: a genuine XLSX formula
    // cell — see `xlsx-parser.ts`) always fails the row, even if
    // `parseProductRow` itself would have accepted it (e.g. the formula was
    // in an optional field) — explicitly rejected, never silently reduced
    // to a blank optional value with nothing but a soft warning. `data` is
    // deliberately NOT cleared here: if `parseProductRow` still produced it
    // (the formula wasn't in a field that fails on its own), the row's SKU
    // etc. remain visible in the error report instead of being lost.
    const errors = row.formatErrors && row.formatErrors.length > 0
      ? [...row.formatErrors, ...schemaErrors]
      : schemaErrors;
    const warnings: string[] = [];
    if (row.neutralizedColumns.length > 0) {
      warnings.push(
        `Formula/control characters removed from: ${row.neutralizedColumns.join(", ")}.`,
      );
    }

    const skuLower = data ? data.sku.toLowerCase() : null;
    if (skuLower) {
      const firstSeenAt = seenSkus.get(skuLower);
      if (firstSeenAt !== undefined) {
        errors.push({
          column: "sku",
          code: "duplicate_sku_in_file",
          message: `SKU already appears on row ${firstSeenAt}.`,
          value: data?.sku ?? null,
        });
      } else {
        seenSkus.set(skuLower, row.rowNumber);
      }
    }

    if (data) {
      const priorName = productNameBySlug.get(data.productSlug);
      if (priorName && priorName !== data.productName) {
        warnings.push(
          `Product name differs from row ${data.productSlug} seen earlier ("${priorName}"); the first value wins.`,
        );
      } else if (!priorName) {
        productNameBySlug.set(data.productSlug, data.productName);
      }

      // Flag option values that aren't among a pre-existing product's declared
      // values for that option — usually a spelling slip in the spreadsheet.
      if (data.options.length > 0) {
        const shape = await getExistingProductShape(db, data.productSlug, catalogCache);
        for (const option of data.options) {
          const known = shape?.options.get(option.name.toLowerCase());
          if (known && !known.has(option.value.toLowerCase())) {
            warnings.push(
              `"${option.value}" is a new value for the existing option "${option.name}" on ` +
                `"${data.productName}" — it will be created. Check for a typo.`,
            );
          }
        }
      }
    }

    let actionLabel: RowAction;
    let rowStatus: ImportRowStatus;
    if (errors.length > 0 || !data) {
      actionLabel = "error";
      rowStatus = ImportRowStatus.FAILED;
    } else if (existingSkus.has(data.sku.toLowerCase())) {
      actionLabel = "update";
      rowStatus = ImportRowStatus.PENDING;
    } else {
      actionLabel = "create";
      rowStatus = ImportRowStatus.PENDING;
    }

    const summary = data
      ? actionLabel === "update"
        ? `Update variant ${data.sku}`
        : `Create variant ${data.sku} on product "${data.productName}"`
      : "Row has errors";

    previewRows.push({
      rowNumber: row.rowNumber,
      sku: data?.sku ?? null,
      action: actionLabel,
      errors,
      warnings,
      summary,
    });
    stagedRows.push({
      rowNumber: row.rowNumber,
      sku: data?.sku ?? null,
      action: rowStatus,
      actionLabel,
      errors,
      raw: row.values,
      normalized: data ?? null,
    });
  }

  const counts = {
    create: previewRows.filter((r) => r.action === "create").length,
    update: previewRows.filter((r) => r.action === "update").length,
    error: previewRows.filter((r) => r.action === "error").length,
  };

  const job = await db.importJob.create({
    data: {
      type: "PRODUCT",
      sourceFormat: rowSource.format === "xlsx" ? "XLSX" : "CSV",
      originalFilename: file.filename.slice(0, 255),
      fileHash,
      status: ImportJobStatus.VALIDATED,
      mode: "upsert",
      totalRows: table.rows.length,
      failedRows: counts.error,
      createdById: authed.id,
      rows: {
        create: stagedRows.map((r) => ({
          rowNumber: r.rowNumber,
          sku: r.sku,
          action: r.actionLabel,
          status: r.action,
          errors: r.errors.length
            ? (r.errors as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          rawData: {
            [CELL_VALUES_KEY]: r.raw,
          } as Prisma.InputJsonValue,
        })),
      },
    },
    select: { id: true },
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.IMPORT_PREVIEWED,
      actorUserId: authed.id,
      entityType: "ImportJob",
      entityId: job.id,
      metadata: { filename: file.filename, fileHash, totalRows: table.rows.length, counts },
      ipAddress: file.ipAddress,
      userAgent: file.userAgent,
    },
    db,
  );

  return {
    importJobId: job.id,
    fileHash,
    filename: file.filename,
    totalRows: table.rows.length,
    counts,
    unknownColumns,
    fileWarnings:
      unknownColumns.length > 0
        ? [`Ignoring unknown column(s): ${unknownColumns.join(", ")}.`]
        : [],
    rows: previewRows,
  };
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export async function commitImport(
  actor: Actor,
  importJobId: string,
  meta: Meta = {},
  db: Db = prisma,
): Promise<ImportCommitResult> {
  const authed = requirePermission(actor, "import.run");

  const job = await db.importJob.findUnique({
    where: { id: importJobId },
    select: { id: true, status: true, type: true },
  });
  if (!job) throw new ImportFileError("job_not_found", "Import job not found.", 404);
  if (job.status !== ImportJobStatus.VALIDATED) {
    throw new ImportFileError(
      "job_wrong_state",
      `This import is ${job.status.toLowerCase()} and can no longer be committed.`,
      409,
    );
  }

  await db.importJob.update({
    where: { id: importJobId },
    data: { status: ImportJobStatus.PROCESSING, startedAt: new Date() },
  });

  const pendingRows = await db.importJob
    .findUniqueOrThrow({ where: { id: importJobId } })
    .rows({ where: { status: ImportRowStatus.PENDING }, orderBy: { rowNumber: "asc" } });

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const failedRows: ImportCommitResult["failedRows"] = [];

  for (const row of pendingRows) {
    const cells = extractCells(row.rawData);
    const parsed = parseProductRow(cells);

    if (!parsed.data || parsed.errors.length > 0) {
      failed += 1;
      failedRows.push({ rowNumber: row.rowNumber, sku: row.sku, errors: parsed.errors });
      await db.importJobRow.update({
        where: { id: row.id },
        data: {
          status: ImportRowStatus.FAILED,
          errors: parsed.errors as unknown as Prisma.InputJsonValue,
        },
      });
      continue;
    }

    try {
      const outcome = await db.$transaction((tx) =>
        applyRow(tx as unknown as CatalogTxClient, parsed.data!, importJobId, authed.id),
      );
      if (outcome === "created") created += 1;
      else if (outcome === "updated") updated += 1;
      else skipped += 1;

      await db.importJobRow.update({
        where: { id: row.id },
        data: {
          status:
            outcome === "created"
              ? ImportRowStatus.CREATED
              : outcome === "updated"
                ? ImportRowStatus.UPDATED
                : ImportRowStatus.NO_CHANGE,
          errors: Prisma.JsonNull,
        },
      });
    } catch (error) {
      failed += 1;
      const rowError: RowError = {
        column: null,
        code: "commit_failed",
        message: error instanceof Error ? error.message : String(error),
      };
      failedRows.push({ rowNumber: row.rowNumber, sku: row.sku, errors: [rowError] });
      await db.importJobRow.update({
        where: { id: row.id },
        data: {
          status: ImportRowStatus.FAILED,
          errors: [rowError] as unknown as Prisma.InputJsonValue,
        },
      });
    }
  }

  const finalStatus =
    failed > 0 && created + updated + skipped === 0
      ? ImportJobStatus.FAILED
      : ImportJobStatus.COMPLETED;

  await db.importJob.update({
    where: { id: importJobId },
    data: {
      status: finalStatus,
      completedAt: new Date(),
      processedRows: created + updated + skipped + failed,
      createdRows: created,
      updatedRows: updated,
      skippedRows: skipped,
      failedRows: failed,
      errorSummary: failed > 0 ? `${failed} row(s) failed. See row detail.` : null,
    },
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.IMPORT_COMMITTED,
      actorUserId: authed.id,
      entityType: "ImportJob",
      entityId: importJobId,
      metadata: { created, updated, skipped, failed, status: finalStatus },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
    db,
  );

  return {
    importJobId,
    status: finalStatus,
    counts: { created, updated, skipped, failed },
    failedRows,
  };
}

export async function cancelImport(
  actor: Actor,
  importJobId: string,
  meta: Meta = {},
  db: Db = prisma,
): Promise<void> {
  const authed = requirePermission(actor, "import.run");
  const job = await db.importJob.findUnique({
    where: { id: importJobId },
    select: { status: true },
  });
  if (!job) throw new ImportFileError("job_not_found", "Import job not found.", 404);
  if (job.status !== ImportJobStatus.VALIDATED) {
    throw new ImportFileError("job_wrong_state", "Only a validated import can be cancelled.", 409);
  }
  await db.importJob.update({
    where: { id: importJobId },
    data: { status: ImportJobStatus.CANCELLED, completedAt: new Date() },
  });
  await recordAudit(
    {
      action: AUDIT_ACTIONS.IMPORT_CANCELLED,
      actorUserId: authed.id,
      entityType: "ImportJob",
      entityId: importJobId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
    db,
  );
}

// ---------------------------------------------------------------------------
// Row application (inside a transaction)
// ---------------------------------------------------------------------------

async function applyRow(
  tx: CatalogTxClient,
  data: NormalizedProductRow,
  importJobId: string,
  actorId: string,
): Promise<"created" | "updated" | "skipped"> {
  let changed = false;

  const brandId = data.brand ? await ensureBrand(tx, data.brand) : undefined;
  const categoryId = data.category ? await ensureCategory(tx, data.category) : undefined;

  const slug = normalizeSlug(data.productSlug || data.productName);
  let product = await tx.product.findUnique({ where: { slug } });
  let productCreated = false;

  if (!product) {
    product = await tx.product.create({
      data: {
        name: data.productName,
        slug,
        description: data.description ?? null,
        status: data.status,
        active: data.status === ProductStatus.ACTIVE,
        brandId: brandId ?? null,
        categoryId: categoryId ?? null,
        publishedAt: data.status === ProductStatus.ACTIVE ? new Date() : null,
      },
    });
    productCreated = true;
    changed = true;
  } else {
    const productPatch: Prisma.ProductUpdateInput = {};
    if (data.description !== undefined && data.description !== product.description) {
      productPatch.description = data.description;
    }
    if (brandId && brandId !== product.brandId) productPatch.brand = { connect: { id: brandId } };
    if (categoryId && categoryId !== product.categoryId) {
      productPatch.category = { connect: { id: categoryId } };
    }
    if (Object.keys(productPatch).length > 0) {
      product = await tx.product.update({ where: { id: product.id }, data: productPatch });
      changed = true;
    }
  }

  const existingVariant = await tx.productVariant.findUnique({
    where: { sku: data.sku },
    include: { inventoryItem: true },
  });

  // A brand-new option (one this product has never seen) is only safe to
  // create implicitly here when there's no OTHER existing variant that would
  // end up missing a value for it. Re-importing a row for an existing variant
  // doesn't count itself as "other". Otherwise the row fails with a clear
  // error pointing at the admin's "extend options" operation, which backfills
  // every existing variant atomically.
  const otherVariantCount = await tx.productVariant.count({
    where: {
      productId: product.id,
      ...(existingVariant ? { id: { not: existingVariant.id } } : {}),
    },
  });
  const allowNewOption = otherVariantCount === 0;

  // Resolve option selections for this variant.
  const joinRows: { optionId: string; optionValueId: string }[] = [];
  for (const option of data.options) {
    joinRows.push(
      await ensureOptionValueTx(tx, product.id, option.name, option.value, { allowNewOption }),
    );
  }
  const signature = optionSignature(joinRows.map((r) => r.optionValueId));

  let variantId: string;
  let variantCreated = false;

  if (existingVariant) {
    if (existingVariant.productId !== product.id) {
      throw new Error(`SKU ${data.sku} already belongs to a different product.`);
    }
    variantId = existingVariant.id;
    // Update-by-SKU: only touch a field the row actually provides. A blank cell
    // is "no opinion" and must never null out existing data (price is always
    // required, so it is always compared).
    const patch: Prisma.ProductVariantUpdateInput = {};
    if (existingVariant.priceCents !== data.priceCents) patch.priceCents = data.priceCents;
    if (
      data.compareAtPriceCents !== undefined &&
      data.compareAtPriceCents !== existingVariant.compareAtPriceCents
    ) {
      patch.compareAtPriceCents = data.compareAtPriceCents;
    }
    if (data.costCents !== undefined && data.costCents !== existingVariant.costCents) {
      patch.costCents = data.costCents;
    }
    if (data.barcode !== undefined && data.barcode !== existingVariant.barcode) {
      patch.barcode = data.barcode;
    }
    if (data.weightGrams !== undefined && data.weightGrams !== existingVariant.weightGrams) {
      patch.weightGrams = data.weightGrams;
    }
    if (Object.keys(patch).length > 0) {
      await tx.productVariant.update({ where: { id: variantId }, data: patch });
      changed = true;
    }
  } else {
    // A duplicate option signature would violate @@unique([productId, optionSignature]).
    const clash = await tx.productVariant.findUnique({
      where: { productId_optionSignature: { productId: product.id, optionSignature: signature } },
      select: { sku: true },
    });
    if (clash) {
      throw new Error(`Option combination already used by SKU ${clash.sku} on this product.`);
    }
    const variant = await tx.productVariant.create({
      data: {
        productId: product.id,
        sku: data.sku,
        barcode: data.barcode ?? null,
        priceCents: data.priceCents,
        compareAtPriceCents: data.compareAtPriceCents ?? null,
        costCents: data.costCents ?? null,
        weightGrams: data.weightGrams ?? null,
        optionSignature: signature,
        optionValues: {
          create: joinRows.map((r) => ({
            option: { connect: { id: r.optionId } },
            optionValue: { connect: { id: r.optionValueId } },
          })),
        },
        inventoryItem: { create: { quantityOnHand: 0, quantityReserved: 0 } },
      },
    });
    variantId = variant.id;
    variantCreated = true;
    changed = true;
  }

  // Inventory (absolute set).
  if (data.inventoryOnHand !== undefined) {
    const moved = await setOnHandTx(tx, variantId, data.inventoryOnHand, {
      type: variantCreated ? StockMovementType.INITIAL : StockMovementType.ADJUSTMENT,
      reason: "CSV import",
      reference: `import:${importJobId}`,
      actorId,
    });
    if (moved) changed = true;
  }

  // Product-level image (external URL only; add once).
  if (data.imageUrl) {
    const existingImage = await tx.productImage.findFirst({
      where: { productId: product.id, variantId: null, url: data.imageUrl },
      select: { id: true },
    });
    if (!existingImage) {
      const imageCount = await tx.productImage.count({ where: { productId: product.id } });
      await tx.productImage.create({
        data: {
          productId: product.id,
          url: data.imageUrl,
          position: imageCount,
          isPrimary: imageCount === 0,
        },
      });
      changed = true;
    }
  }

  // Variant-level image (external URL only; add once, never the product primary).
  if (data.variantImageUrl) {
    const existingVariantImage = await tx.productImage.findFirst({
      where: { productId: product.id, variantId, url: data.variantImageUrl },
      select: { id: true },
    });
    if (!existingVariantImage) {
      const imageCount = await tx.productImage.count({ where: { productId: product.id } });
      await tx.productImage.create({
        data: {
          productId: product.id,
          variantId,
          url: data.variantImageUrl,
          position: imageCount,
          isPrimary: false,
        },
      });
      changed = true;
    }
  }

  if (productCreated || variantCreated) return "created";
  return changed ? "updated" : "skipped";
}

async function ensureBrand(tx: Pick<CatalogTxClient, "brand">, name: string): Promise<string> {
  const trimmed = name.trim();
  const existing = await tx.brand.findUnique({ where: { name: trimmed }, select: { id: true } });
  if (existing) return existing.id;
  const brand = await tx.brand.create({
    data: { name: trimmed, slug: normalizeSlug(trimmed) },
    select: { id: true },
  });
  return brand.id;
}

async function ensureCategory(
  tx: Pick<CatalogTxClient, "category">,
  name: string,
): Promise<string> {
  const trimmed = name.trim();
  const slug = normalizeSlug(trimmed);
  const existing = await tx.category.findUnique({ where: { slug }, select: { id: true } });
  if (existing) return existing.id;
  const category = await tx.category.create({
    data: { name: trimmed, slug },
    select: { id: true },
  });
  return category.id;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractCells(rawData: Prisma.JsonValue): Record<string, string> {
  if (rawData && typeof rawData === "object" && !Array.isArray(rawData)) {
    const cells = (rawData as Record<string, unknown>)[CELL_VALUES_KEY];
    if (cells && typeof cells === "object" && !Array.isArray(cells)) {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(cells as Record<string, unknown>)) {
        out[key] = typeof value === "string" ? value : String(value ?? "");
      }
      return out;
    }
  }
  return {};
}

async function lookupExistingSkus(
  db: Pick<PrismaClient, "productVariant">,
  skus: string[],
): Promise<Set<string>> {
  if (skus.length === 0) return new Set();
  const found = await db.productVariant.findMany({
    where: { sku: { in: [...new Set(skus)] } },
    select: { sku: true },
  });
  return new Set(found.map((v) => v.sku.toLowerCase()));
}

interface ExistingProductShape {
  /** lower-cased option name -> set of lower-cased existing values. */
  options: Map<string, Set<string>>;
}

/** Cached, per-slug lookup of an already-existing product's declared options. */
async function getExistingProductShape(
  db: Pick<PrismaClient, "product">,
  slug: string,
  cache: Map<string, ExistingProductShape | null>,
): Promise<ExistingProductShape | null> {
  if (cache.has(slug)) return cache.get(slug)!;
  const product = await db.product.findUnique({
    where: { slug },
    select: { options: { select: { name: true, values: { select: { value: true } } } } },
  });
  const shape: ExistingProductShape | null = product
    ? {
        options: new Map(
          product.options.map((option) => [
            option.name.toLowerCase(),
            new Set(option.values.map((v) => v.value.toLowerCase())),
          ]),
        ),
      }
    : null;
  cache.set(slug, shape);
  return shape;
}

export type { ParsedRow };
