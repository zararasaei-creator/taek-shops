import { ProductStatus, type Prisma, type PrismaClient } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { resolveImageUrl } from "@/server/catalog/image-service";

/**
 * Public (storefront) catalogue reads.
 *
 * A product is publicly sellable only when its `status` is `ACTIVE` AND it has
 * at least one active variant. These filters live here so no public surface can
 * accidentally expose a draft or archived product. No authorization check —
 * these are the public API.
 */

const PUBLIC_PRODUCT_WHERE: Prisma.ProductWhereInput = {
  status: ProductStatus.ACTIVE,
  active: true,
  variants: { some: { active: true } },
};

const publicProductSelect = {
  id: true,
  name: true,
  slug: true,
  description: true,
  featured: true,
  brand: { select: { name: true, slug: true } },
  category: { select: { name: true, slug: true } },
  images: {
    where: { variantId: null },
    orderBy: [{ isPrimary: "desc" }, { position: "asc" }],
    select: { url: true, altText: true, isPrimary: true },
  },
  variants: {
    where: { active: true },
    orderBy: { position: "asc" },
    select: {
      id: true,
      sku: true,
      name: true,
      priceCents: true,
      compareAtPriceCents: true,
      currency: true,
      optionValues: {
        select: {
          option: { select: { name: true, position: true } },
          optionValue: { select: { value: true, position: true } },
        },
      },
    },
  },
} satisfies Prisma.ProductSelect;

type RawPublicProduct = Prisma.ProductGetPayload<{ select: typeof publicProductSelect }>;

export interface PublicProduct {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  featured: boolean;
  brand: { name: string; slug: string } | null;
  category: { name: string; slug: string } | null;
  images: { url: string; altText: string | null; isPrimary: boolean }[];
  priceRange: { minCents: number; maxCents: number };
  variants: {
    id: string;
    sku: string;
    name: string | null;
    priceCents: number;
    compareAtPriceCents: number | null;
    options: { option: string; value: string }[];
  }[];
}

function present(row: RawPublicProduct): PublicProduct {
  const prices = row.variants.map((v) => v.priceCents);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    featured: row.featured,
    brand: row.brand,
    category: row.category,
    images: row.images.map((image) => ({
      url: resolveImageUrl(image.url),
      altText: image.altText,
      isPrimary: image.isPrimary,
    })),
    priceRange: {
      minCents: prices.length ? Math.min(...prices) : 0,
      maxCents: prices.length ? Math.max(...prices) : 0,
    },
    variants: row.variants.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      name: variant.name,
      priceCents: variant.priceCents,
      compareAtPriceCents: variant.compareAtPriceCents,
      options: variant.optionValues
        .map((ov) => ({
          option: ov.option.name,
          value: ov.optionValue.value,
          op: ov.option.position,
          vp: ov.optionValue.position,
        }))
        .sort((a, b) => a.op - b.op || a.vp - b.vp)
        .map(({ option, value }) => ({ option, value })),
    })),
  };
}

export interface PublicCatalogQuery {
  skip?: number;
  take?: number;
  categorySlug?: string;
  brandSlug?: string;
  search?: string;
  featuredOnly?: boolean;
}

export async function listPublicProducts(
  query: PublicCatalogQuery = {},
  db: Pick<PrismaClient, "product"> = prisma,
): Promise<{ products: PublicProduct[]; total: number }> {
  const take = Math.min(Math.max(query.take ?? 24, 1), 100);
  const skip = Math.max(query.skip ?? 0, 0);

  const where: Prisma.ProductWhereInput = {
    ...PUBLIC_PRODUCT_WHERE,
    ...(query.featuredOnly ? { featured: true } : {}),
    ...(query.categorySlug ? { category: { slug: query.categorySlug, active: true } } : {}),
    ...(query.brandSlug ? { brand: { slug: query.brandSlug, active: true } } : {}),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: "insensitive" } },
            { description: { contains: query.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    db.product.findMany({
      where,
      select: publicProductSelect,
      orderBy: [{ featured: "desc" }, { name: "asc" }],
      skip,
      take,
    }),
    db.product.count({ where }),
  ]);
  return { products: rows.map(present), total };
}

export async function getPublicProductBySlug(
  slug: string,
  db: Pick<PrismaClient, "product"> = prisma,
): Promise<PublicProduct | null> {
  const row = await db.product.findFirst({
    where: { ...PUBLIC_PRODUCT_WHERE, slug },
    select: publicProductSelect,
  });
  return row ? present(row) : null;
}
