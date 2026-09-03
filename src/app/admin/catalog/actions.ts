"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { ProductStatus, StockMovementType } from "@prisma/client";

import { getCurrentUser } from "@/server/auth";
import { isAuthError } from "@/server/auth/errors";
import { isCatalogError } from "@/server/catalog/errors";
import { createBrand, updateBrand } from "@/server/catalog/brand-service";
import { createCategory, updateCategory } from "@/server/catalog/category-service";
import {
  changeProductStatus,
  createProduct,
  updateProduct,
} from "@/server/catalog/product-service";
import { addProductOption } from "@/server/catalog/option-service";
import { createVariant } from "@/server/catalog/variant-service";
import { adjustInventory } from "@/server/inventory/inventory-service";
import { parseAmountToCents } from "@/server/domain/money";
import { ADJUSTMENT_MOVEMENT_TYPES } from "@/lib/validation/catalog";

type AdjustmentType = (typeof ADJUSTMENT_MOVEMENT_TYPES)[number];

/**
 * Server actions for the admin catalogue UI. Every action re-resolves the actor
 * server-side and delegates to a service that enforces authorization — the UI is
 * never the security boundary. Failures are returned as `{ ok: false, error }`
 * for the form to render; unexpected errors are re-thrown.
 */

export type ActionResult = { ok: true; id?: string } | { ok: false; error: string };

async function requestMeta() {
  const h = await headers();
  return {
    ipAddress: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: h.get("user-agent"),
  };
}

async function run(fn: () => Promise<unknown>): Promise<ActionResult> {
  try {
    const result = await fn();
    const id =
      result && typeof result === "object" && "id" in result && typeof result.id === "string"
        ? result.id
        : undefined;
    return { ok: true, id };
  } catch (error) {
    if (isCatalogError(error) || isAuthError(error)) {
      return { ok: false, error: error.publicMessage };
    }
    throw error;
  }
}

function str(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}
function optional(form: FormData, key: string): string | undefined {
  const v = str(form, key);
  return v || undefined;
}
function centsFromDollars(form: FormData, key: string): number | undefined {
  const v = str(form, key);
  return v ? parseAmountToCents(v) : undefined;
}

// ---------------------------------------------------------------------------
// Brands & categories
// ---------------------------------------------------------------------------

export async function createBrandAction(_prev: ActionResult | null, form: FormData) {
  const actor = await getCurrentUser();
  const meta = await requestMeta();
  const result = await run(async () => {
    const brand = await createBrand(actor, {
      name: str(form, "name"),
      slug: optional(form, "slug"),
      description: optional(form, "description"),
      active: form.get("active") !== "false",
      ...meta,
    });
    return { id: brand.id };
  });
  revalidatePath("/admin/catalog/brands");
  return result;
}

export async function updateBrandAction(id: string, _prev: ActionResult | null, form: FormData) {
  const actor = await getCurrentUser();
  const meta = await requestMeta();
  const result = await run(() =>
    updateBrand(actor, id, {
      name: optional(form, "name"),
      description: optional(form, "description"),
      active: form.get("active") === "on" || form.get("active") === "true",
      ...meta,
    }),
  );
  revalidatePath("/admin/catalog/brands");
  return result;
}

export async function createCategoryAction(_prev: ActionResult | null, form: FormData) {
  const actor = await getCurrentUser();
  const meta = await requestMeta();
  const result = await run(async () => {
    const category = await createCategory(actor, {
      name: str(form, "name"),
      slug: optional(form, "slug"),
      description: optional(form, "description"),
      parentId: optional(form, "parentId") ?? null,
      sortOrder: Number(str(form, "sortOrder") || "0"),
      active: form.get("active") !== "false",
      ...meta,
    });
    return { id: category.id };
  });
  revalidatePath("/admin/catalog/categories");
  return result;
}

export async function updateCategoryAction(id: string, _prev: ActionResult | null, form: FormData) {
  const actor = await getCurrentUser();
  const meta = await requestMeta();
  const result = await run(() =>
    updateCategory(actor, id, {
      name: optional(form, "name"),
      description: optional(form, "description"),
      parentId: form.has("parentId") ? (optional(form, "parentId") ?? null) : undefined,
      sortOrder: form.has("sortOrder") ? Number(str(form, "sortOrder")) : undefined,
      active: form.get("active") === "on" || form.get("active") === "true",
      ...meta,
    }),
  );
  revalidatePath("/admin/catalog/categories");
  return result;
}

// ---------------------------------------------------------------------------
// Products, options, variants
// ---------------------------------------------------------------------------

export async function createProductAction(_prev: ActionResult | null, form: FormData) {
  const actor = await getCurrentUser();
  const meta = await requestMeta();
  const sku = optional(form, "sku");
  const priceRaw = optional(form, "price");

  const result = await run(async () => {
    const product = await createProduct(actor, {
      name: str(form, "name"),
      slug: optional(form, "slug"),
      description: optional(form, "description"),
      status: (optional(form, "status") as ProductStatus) ?? ProductStatus.DRAFT,
      brandId: optional(form, "brandId") ?? null,
      categoryId: optional(form, "categoryId") ?? null,
      ...meta,
      defaultVariant:
        sku && priceRaw
          ? {
              sku,
              priceCents: parseAmountToCents(priceRaw),
              compareAtPriceCents: centsFromDollars(form, "compareAtPrice"),
              initialQuantity: Number(str(form, "initialQuantity") || "0"),
              position: 0,
              active: true,
              trackInventory: true,
              optionSelections: [],
            }
          : undefined,
    });
    return { id: product.id };
  });
  revalidatePath("/admin/catalog/products");
  if (result.ok && result.id) redirect(`/admin/catalog/products/${result.id}`);
  return result;
}

export async function updateProductAction(id: string, _prev: ActionResult | null, form: FormData) {
  const actor = await getCurrentUser();
  const meta = await requestMeta();
  const result = await run(() =>
    updateProduct(actor, id, {
      name: optional(form, "name"),
      description: optional(form, "description"),
      featured: form.get("featured") === "on",
      brandId: form.has("brandId") ? (optional(form, "brandId") ?? null) : undefined,
      categoryId: form.has("categoryId") ? (optional(form, "categoryId") ?? null) : undefined,
      seoTitle: optional(form, "seoTitle"),
      ...meta,
    }),
  );
  revalidatePath(`/admin/catalog/products/${id}`);
  return result;
}

export async function changeProductStatusAction(
  id: string,
  status: ProductStatus,
): Promise<ActionResult> {
  const actor = await getCurrentUser();
  const meta = await requestMeta();
  const result = await run(() => changeProductStatus(actor, id, status, meta));
  revalidatePath(`/admin/catalog/products/${id}`);
  revalidatePath("/admin/catalog/products");
  return result;
}

export async function addOptionAction(
  productId: string,
  _prev: ActionResult | null,
  form: FormData,
) {
  const actor = await getCurrentUser();
  const meta = await requestMeta();
  const result = await run(() =>
    addProductOption(
      actor,
      productId,
      {
        name: str(form, "name"),
        values: str(form, "values")
          .split(/[\n,]/)
          .map((v) => v.trim())
          .filter(Boolean),
        position: 0,
      },
      meta,
    ),
  );
  revalidatePath(`/admin/catalog/products/${productId}`);
  return result;
}

export async function addVariantAction(
  productId: string,
  _prev: ActionResult | null,
  form: FormData,
) {
  const actor = await getCurrentUser();
  const meta = await requestMeta();

  const optionSelections: { option: string; value: string }[] = [];
  for (const key of form.keys()) {
    const match = /^option_(.+)$/.exec(key);
    if (match) {
      const value = str(form, key);
      if (value) optionSelections.push({ option: decodeURIComponent(match[1]!), value });
    }
  }

  const result = await run(async () => {
    const variant = await createVariant(actor, productId, {
      sku: str(form, "sku"),
      name: optional(form, "name"),
      priceCents: parseAmountToCents(str(form, "price")),
      compareAtPriceCents: centsFromDollars(form, "compareAtPrice"),
      costCents: centsFromDollars(form, "costPrice"),
      weightGrams: str(form, "weightGrams") ? Number(str(form, "weightGrams")) : undefined,
      initialQuantity: Number(str(form, "initialQuantity") || "0"),
      position: 0,
      active: true,
      trackInventory: true,
      optionSelections,
      ...meta,
    });
    return { id: variant.id };
  });
  revalidatePath(`/admin/catalog/products/${productId}`);
  return result;
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export async function adjustInventoryAction(_prev: ActionResult | null, form: FormData) {
  const actor = await getCurrentUser();
  const meta = await requestMeta();
  const mode = str(form, "mode");
  const amount = Number(str(form, "amount"));

  const result = await run(() =>
    adjustInventory(actor, {
      sku: str(form, "sku"),
      ...(mode === "set" ? { setOnHand: amount } : { delta: amount }),
      type: (optional(form, "type") as AdjustmentType | undefined) ?? StockMovementType.ADJUSTMENT,
      reason: str(form, "reason"),
      reference: optional(form, "reference"),
      ...meta,
    }),
  );
  revalidatePath("/admin/catalog/inventory");
  return result;
}
