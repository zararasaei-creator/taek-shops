import { ProductStatus } from "@prisma/client";

import { MoneyError, parseAmountToCents } from "@/server/domain/money";
import { isValidSlug, slugify } from "@/server/catalog/slug";
import { MAX_PRICE_CENTS } from "@/lib/validation/catalog";
import type { RowError } from "@/server/import/errors";

/**
 * Row-level parsing + normalisation + business validation for a product-import
 * CSV row. Every problem is collected as a `RowError` — nothing throws. A row
 * with any error is never written.
 */

export interface NormalizedProductRow {
  sku: string;
  productName: string;
  productSlug: string;
  description?: string;
  brand?: string;
  category?: string;
  status: ProductStatus;
  priceCents: number;
  compareAtPriceCents?: number;
  costCents?: number;
  barcode?: string;
  weightGrams?: number;
  /** `undefined` => leave inventory unchanged (update) / 0 (create). */
  inventoryQuantity?: number;
  options: { name: string; value: string }[];
  imageUrl?: string;
}

const STATUS_MAP: Record<string, ProductStatus> = {
  draft: ProductStatus.DRAFT,
  active: ProductStatus.ACTIVE,
  archived: ProductStatus.ARCHIVED,
};

function err(column: string | null, code: string, message: string, value?: string): RowError {
  return { column, code, message, value: value ?? null };
}

function optionalInt(
  raw: string,
  column: string,
  errors: RowError[],
  opts: { min?: number; max?: number } = {},
): number | undefined {
  if (!raw) return undefined;
  if (!/^-?\d+$/.test(raw)) {
    errors.push(err(column, "invalid_integer", `"${raw}" is not a whole number.`, raw));
    return undefined;
  }
  const n = Number(raw);
  if (opts.min !== undefined && n < opts.min) {
    errors.push(err(column, "out_of_range", `Must be >= ${opts.min}.`, raw));
    return undefined;
  }
  if (opts.max !== undefined && n > opts.max) {
    errors.push(err(column, "out_of_range", `Must be <= ${opts.max}.`, raw));
    return undefined;
  }
  return n;
}

function optionalCents(raw: string, column: string, errors: RowError[]): number | undefined {
  if (!raw) return undefined;
  try {
    const cents = parseAmountToCents(raw);
    if (cents < 0) {
      errors.push(err(column, "negative_amount", "Must not be negative.", raw));
      return undefined;
    }
    if (cents > MAX_PRICE_CENTS) {
      errors.push(err(column, "amount_too_large", "Amount exceeds the maximum.", raw));
      return undefined;
    }
    return cents;
  } catch (error) {
    if (error instanceof MoneyError) {
      errors.push(err(column, "invalid_amount", `"${raw}" is not a valid money amount.`, raw));
      return undefined;
    }
    throw error;
  }
}

export function parseProductRow(values: Record<string, string>): {
  data?: NormalizedProductRow;
  errors: RowError[];
} {
  const errors: RowError[] = [];
  const get = (key: string): string => (values[key] ?? "").trim();

  // --- SKU (update key) ---
  const sku = get("sku");
  if (!sku) {
    errors.push(err("sku", "required", "SKU is required."));
  } else if (sku.length < 3 || sku.length > 64) {
    errors.push(err("sku", "length", "SKU must be 3-64 characters.", sku));
  } else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sku)) {
    errors.push(err("sku", "format", "SKU may contain letters, digits, '.', '_' and '-'.", sku));
  }

  // --- Product name + slug ---
  const productName = get("product_name");
  if (!productName) {
    errors.push(err("product_name", "required", "Product name is required."));
  } else if (productName.length > 200) {
    errors.push(
      err("product_name", "length", "Product name must be <= 200 characters.", productName),
    );
  }

  const rawSlug = get("product_slug");
  let productSlug = "";
  if (rawSlug) {
    if (!isValidSlug(rawSlug)) {
      errors.push(
        err(
          "product_slug",
          "format",
          "Slug must be lower-case words separated by hyphens.",
          rawSlug,
        ),
      );
    } else {
      productSlug = rawSlug;
    }
  } else if (productName) {
    productSlug = slugify(productName);
    if (!productSlug) {
      errors.push(
        err("product_slug", "underivable", "Cannot derive a slug from the product name."),
      );
    }
  }

  // --- Status ---
  const rawStatus = get("status").toLowerCase();
  let status: ProductStatus = ProductStatus.DRAFT;
  if (rawStatus) {
    const mapped = STATUS_MAP[rawStatus];
    if (!mapped) {
      errors.push(
        err("status", "invalid_enum", "Status must be draft, active or archived.", rawStatus),
      );
    } else {
      status = mapped;
    }
  }

  // --- Money ---
  let priceCents: number | undefined;
  const rawPrice = get("price");
  if (!rawPrice) {
    errors.push(err("price", "required", "Price is required."));
  } else {
    priceCents = optionalCents(rawPrice, "price", errors);
    if (priceCents !== undefined && priceCents <= 0) {
      errors.push(err("price", "not_positive", "Price must be greater than zero.", rawPrice));
      priceCents = undefined;
    }
  }
  const compareAtPriceCents = optionalCents(get("compare_at_price"), "compare_at_price", errors);
  const costCents = optionalCents(get("cost_price"), "cost_price", errors);
  if (
    priceCents !== undefined &&
    compareAtPriceCents !== undefined &&
    compareAtPriceCents <= priceCents
  ) {
    errors.push(
      err("compare_at_price", "not_greater", "Compare-at price must be greater than the price."),
    );
  }

  // --- Ints ---
  const weightGrams = optionalInt(get("weight_grams"), "weight_grams", errors, {
    min: 0,
    max: 1_000_000,
  });
  const inventoryQuantity = optionalInt(get("inventory_quantity"), "inventory_quantity", errors, {
    min: 0,
    max: 1_000_000,
  });

  // --- Barcode ---
  const barcode = get("barcode") || undefined;
  if (barcode && (barcode.length < 4 || barcode.length > 64)) {
    errors.push(err("barcode", "length", "Barcode must be 4-64 characters.", barcode));
  }

  // --- Options (up to 3 pairs; not limited to Size/Colour) ---
  const options: { name: string; value: string }[] = [];
  const seenOptionNames = new Set<string>();
  for (const index of [1, 2, 3]) {
    const name = get(`option${index}_name`);
    const value = get(`option${index}_value`);
    if (!name && !value) continue;
    if (!name || !value) {
      errors.push(
        err(
          !name ? `option${index}_name` : `option${index}_value`,
          "incomplete_option",
          `option${index} needs both a name and a value.`,
        ),
      );
      continue;
    }
    if (name.length > 60 || value.length > 80) {
      errors.push(
        err(`option${index}_name`, "length", "Option name <= 60, value <= 80 characters."),
      );
      continue;
    }
    const key = name.toLowerCase();
    if (seenOptionNames.has(key)) {
      errors.push(
        err(
          `option${index}_name`,
          "duplicate_option",
          `Option "${name}" is repeated in this row.`,
          name,
        ),
      );
      continue;
    }
    seenOptionNames.add(key);
    options.push({ name, value });
  }

  // --- Image ---
  const rawImage = get("image_url");
  let imageUrl: string | undefined;
  if (rawImage) {
    try {
      const url = new URL(rawImage);
      if (url.protocol !== "https:") {
        errors.push(err("image_url", "not_https", "Image URL must use https.", rawImage));
      } else {
        imageUrl = url.toString();
      }
    } catch {
      errors.push(err("image_url", "invalid_url", "Image URL is not a valid URL.", rawImage));
    }
  }

  if (errors.length > 0) return { errors };

  return {
    errors: [],
    data: {
      sku,
      productName,
      productSlug,
      description: get("description") || undefined,
      brand: get("brand") || undefined,
      category: get("category") || undefined,
      status,
      priceCents: priceCents!,
      compareAtPriceCents,
      costCents,
      barcode,
      weightGrams,
      inventoryQuantity,
      options,
      imageUrl,
    },
  };
}
