import { ProductStatus, StockMovementType } from "@prisma/client";
import { z } from "zod";

import { SLUG_MAX_LENGTH, SLUG_PATTERN } from "@/server/catalog/slug";

/**
 * Shared catalogue input schemas. Money is always integer cents; SKU/slug rules
 * are enforced here and again by the service + database constraints.
 */

export const MAX_PRICE_CENTS = 100_000_00; // $100,000 upper sanity bound

export const priceCentsSchema = z.number().int().min(0).max(MAX_PRICE_CENTS);
export const optionalPriceCentsSchema = priceCentsSchema.optional();

export const skuSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "SKU may contain letters, digits, '.', '_' and '-'.");

export const slugInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(SLUG_MAX_LENGTH)
  .regex(SLUG_PATTERN, "Slug must be lower-case words separated by single hyphens.");

export const nameSchema = z.string().trim().min(1).max(200);
export const shortTextSchema = z.string().trim().max(200);
export const longTextSchema = z.string().trim().max(20_000);

// ---------------------------------------------------------------------------
// Brand
// ---------------------------------------------------------------------------

export const brandCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slugInputSchema.optional(),
  description: longTextSchema.optional(),
  active: z.boolean().default(true),
});
export type BrandCreateInput = z.input<typeof brandCreateSchema>;

export const brandUpdateSchema = brandCreateSchema.partial();
export type BrandUpdateInput = z.infer<typeof brandUpdateSchema>;

// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------

export const categoryCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slugInputSchema.optional(),
  description: longTextSchema.optional(),
  parentId: z.string().min(1).nullable().optional(),
  sortOrder: z.number().int().min(0).max(100_000).default(0),
  active: z.boolean().default(true),
});
export type CategoryCreateInput = z.input<typeof categoryCreateSchema>;

export const categoryUpdateSchema = categoryCreateSchema.partial();
export type CategoryUpdateInput = z.infer<typeof categoryUpdateSchema>;

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------

export const productCreateSchema = z.object({
  name: nameSchema,
  slug: slugInputSchema.optional(),
  description: longTextSchema.optional(),
  status: z.enum(ProductStatus).default(ProductStatus.DRAFT),
  featured: z.boolean().default(false),
  brandId: z.string().min(1).nullable().optional(),
  categoryId: z.string().min(1).nullable().optional(),
  taxCategory: shortTextSchema.optional(),
  seoTitle: shortTextSchema.optional(),
  seoDescription: z.string().trim().max(400).optional(),
});
export type ProductCreateInput = z.input<typeof productCreateSchema>;

export const productUpdateSchema = productCreateSchema.partial();
export type ProductUpdateInput = z.input<typeof productUpdateSchema>;

export const productStatusChangeSchema = z.object({
  status: z.enum(ProductStatus),
});

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export const productOptionInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  values: z.array(z.string().trim().min(1).max(80)).min(1).max(100),
  position: z.number().int().min(0).max(1000).default(0),
});

export const productOptionsSchema = z.object({
  options: z.array(productOptionInputSchema).max(20),
});
export type ProductOptionsInput = z.infer<typeof productOptionsSchema>;

/**
 * Extend an existing product with a brand-new option. If the product already
 * has variants, `backfill` must supply exactly one of the new `values` for
 * every existing variant — see `extendProductOption` in option-service.ts.
 */
export const extendOptionInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  values: z.array(z.string().trim().min(1).max(80)).min(1).max(100),
  position: z.number().int().min(0).max(1000).default(0),
  backfill: z
    .array(
      z.object({
        variantId: z.string().min(1),
        value: z.string().trim().min(1).max(80),
      }),
    )
    .max(10_000)
    .default([]),
});
export type ExtendOptionInput = z.input<typeof extendOptionInputSchema>;

// ---------------------------------------------------------------------------
// Variant
// ---------------------------------------------------------------------------

/** A variant's option selection, expressed by option name + value (human-friendly). */
export const variantOptionSelectionSchema = z.object({
  option: z.string().trim().min(1).max(60),
  value: z.string().trim().min(1).max(80),
});

export const variantCreateSchema = z.object({
  sku: skuSchema,
  barcode: z.string().trim().min(4).max(64).optional(),
  name: shortTextSchema.optional(),
  priceCents: priceCentsSchema,
  compareAtPriceCents: optionalPriceCentsSchema,
  costCents: optionalPriceCentsSchema,
  weightGrams: z.number().int().min(0).max(1_000_000).optional(),
  position: z.number().int().min(0).max(100_000).default(0),
  active: z.boolean().default(true),
  trackInventory: z.boolean().default(true),
  initialQuantity: z.number().int().min(0).max(1_000_000).default(0),
  optionSelections: z.array(variantOptionSelectionSchema).max(20).default([]),
});
export type VariantCreateInput = z.input<typeof variantCreateSchema>;

export const variantUpdateSchema = variantCreateSchema.omit({ initialQuantity: true }).partial();
export type VariantUpdateInput = z.input<typeof variantUpdateSchema>;

/**
 * One generated cell from the admin Variant Matrix Generator — the same shape
 * as a single variant create, except a matrix cell must select at least one
 * option (a 0-dimension "matrix" isn't a matrix).
 */
export const matrixCellSchema = variantCreateSchema.extend({
  optionSelections: z.array(variantOptionSelectionSchema).min(1).max(20),
});
export type MatrixCellInput = z.input<typeof matrixCellSchema>;

export const matrixGenerateSchema = z.object({
  cells: z.array(matrixCellSchema).min(1).max(500),
});
export type MatrixGenerateInput = z.input<typeof matrixGenerateSchema>;

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export const productImageInputSchema = z.object({
  storageKey: z.string().trim().min(1).max(500),
  altText: z.string().trim().max(300).optional(),
  position: z.number().int().min(0).max(1000).default(0),
  isPrimary: z.boolean().default(false),
  variantId: z.string().min(1).nullable().optional(),
});
export type ProductImageInput = z.infer<typeof productImageInputSchema>;

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export const ADJUSTMENT_MOVEMENT_TYPES = [
  StockMovementType.ADJUSTMENT,
  StockMovementType.PURCHASE,
  StockMovementType.RETURN,
  StockMovementType.INITIAL,
] as const;

export const inventoryAdjustSchema = z
  .object({
    variantId: z.string().min(1).optional(),
    sku: skuSchema.optional(),
    /** Signed change to apply, e.g. -3 or +10. Mutually exclusive with `setOnHand`. */
    delta: z.number().int().min(-1_000_000).max(1_000_000).optional(),
    /** Absolute target on-hand quantity. Mutually exclusive with `delta`. */
    setOnHand: z.number().int().min(0).max(1_000_000).optional(),
    type: z.enum(ADJUSTMENT_MOVEMENT_TYPES).default(StockMovementType.ADJUSTMENT),
    reason: z.string().trim().min(1).max(500),
    reference: z.string().trim().max(200).optional(),
  })
  .refine((v) => Boolean(v.variantId) !== Boolean(v.sku), {
    message: "Provide exactly one of `variantId` or `sku`.",
  })
  .refine((v) => (v.delta === undefined) !== (v.setOnHand === undefined), {
    message: "Provide exactly one of `delta` or `setOnHand`.",
  })
  .refine((v) => v.delta === undefined || v.delta !== 0, {
    message: "`delta` must not be zero.",
  });
export type InventoryAdjustInput = z.input<typeof inventoryAdjustSchema>;
