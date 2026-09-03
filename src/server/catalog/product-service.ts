import { ProductStatus, type Prisma, type PrismaClient } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { requirePermission, type AuthUser } from "@/server/auth/authorization";
import { recordAudit } from "@/server/audit/audit-service";
import { AUDIT_ACTIONS } from "@/server/audit/actions";
import {
  CatalogValidationError,
  ConflictError,
  InvalidStateTransitionError,
  NotFoundError,
  ReferentialIntegrityError,
} from "@/server/catalog/errors";
import { normalizeSlug } from "@/server/catalog/slug";
import type { CatalogTxClient } from "@/server/catalog/tx";
import { createVariantTx } from "@/server/catalog/variant-service";
import {
  productCreateSchema,
  productUpdateSchema,
  variantCreateSchema,
  type ProductCreateInput,
  type ProductUpdateInput,
  type VariantCreateInput,
} from "@/lib/validation/catalog";

/**
 * Product administration and lifecycle.
 *
 * Lifecycle: `DRAFT` -> `ACTIVE` -> `ARCHIVED` (and back). `Product.active` is
 * kept mirrored to `status === ACTIVE` so public queries can filter on either.
 * A product may only become `ACTIVE` when it has at least one active variant.
 * Products referenced by orders are archived, never hard-deleted.
 */

type Db = PrismaClient;
type Actor = AuthUser | null | undefined;

interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

async function assertSlugFree(
  db: Pick<Db, "product">,
  slug: string,
  exceptId?: string,
): Promise<void> {
  const existing = await db.product.findUnique({ where: { slug }, select: { id: true } });
  if (existing && existing.id !== exceptId) {
    throw new ConflictError(`A product with the slug "${slug}" already exists.`);
  }
}

async function assertReferencesExist(
  tx: Pick<CatalogTxClient, "brand" | "category">,
  brandId: string | null | undefined,
  categoryId: string | null | undefined,
): Promise<void> {
  if (brandId) {
    const brand = await tx.brand.findUnique({ where: { id: brandId }, select: { id: true } });
    if (!brand) throw new CatalogValidationError(`Brand ${brandId} does not exist.`);
  }
  if (categoryId) {
    const category = await tx.category.findUnique({
      where: { id: categoryId },
      select: { id: true },
    });
    if (!category) throw new CatalogValidationError(`Category ${categoryId} does not exist.`);
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListProductsOptions {
  skip?: number;
  take?: number;
  search?: string;
  status?: ProductStatus;
  brandId?: string;
  categoryId?: string;
}

const adminProductInclude = {
  brand: { select: { id: true, name: true } },
  category: { select: { id: true, name: true } },
  _count: { select: { variants: true, images: true } },
} satisfies Prisma.ProductInclude;

export async function listProducts(
  actor: Actor,
  options: ListProductsOptions = {},
  db: Db = prisma,
): Promise<{
  products: Prisma.ProductGetPayload<{ include: typeof adminProductInclude }>[];
  total: number;
}> {
  requirePermission(actor, "catalog.read");
  const take = Math.min(Math.max(options.take ?? 50, 1), 200);
  const skip = Math.max(options.skip ?? 0, 0);

  const where: Prisma.ProductWhereInput = {
    ...(options.status ? { status: options.status } : {}),
    ...(options.brandId ? { brandId: options.brandId } : {}),
    ...(options.categoryId ? { categoryId: options.categoryId } : {}),
    ...(options.search
      ? {
          OR: [
            { name: { contains: options.search, mode: "insensitive" } },
            { slug: { contains: options.search.toLowerCase() } },
            { variants: { some: { sku: { contains: options.search, mode: "insensitive" } } } },
          ],
        }
      : {}),
  };

  const [products, total] = await Promise.all([
    db.product.findMany({
      where,
      include: adminProductInclude,
      orderBy: { updatedAt: "desc" },
      skip,
      take,
    }),
    db.product.count({ where }),
  ]);
  return { products, total };
}

const productDetailInclude = {
  brand: true,
  category: true,
  options: { include: { values: { orderBy: { position: "asc" } } }, orderBy: { position: "asc" } },
  images: { orderBy: { position: "asc" } },
  variants: {
    orderBy: { position: "asc" },
    include: {
      optionValues: { include: { option: true, optionValue: true } },
      inventoryItem: true,
    },
  },
} satisfies Prisma.ProductInclude;

export type ProductDetail = Prisma.ProductGetPayload<{ include: typeof productDetailInclude }>;

export async function getProductDetail(
  actor: Actor,
  idOrSlug: string,
  db: Db = prisma,
): Promise<ProductDetail> {
  requirePermission(actor, "catalog.read");
  const product = await db.product.findFirst({
    where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    include: productDetailInclude,
  });
  if (!product) throw new NotFoundError("Product", idOrSlug);
  return product;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface CreateProductInput extends ProductCreateInput, Meta {
  /** Optional single default variant, created atomically with the product. */
  defaultVariant?: VariantCreateInput;
}

export async function createProduct(
  actor: Actor,
  input: CreateProductInput,
  db: Db = prisma,
): Promise<ProductDetail> {
  const authed = requirePermission(actor, "catalog.write");
  const data = productCreateSchema.parse(input);
  const defaultVariant = input.defaultVariant
    ? variantCreateSchema.parse(input.defaultVariant)
    : undefined;

  const slug = normalizeSlug(data.slug ?? data.name);
  const status = data.status;

  const product = await db.$transaction(async (tx) => {
    await assertSlugFree(tx, slug);
    await assertReferencesExist(tx, data.brandId, data.categoryId);

    if (status === ProductStatus.ACTIVE && !defaultVariant) {
      throw new InvalidStateTransitionError(
        "A product needs at least one active variant before it can be ACTIVE.",
      );
    }

    const created = await tx.product.create({
      data: {
        name: data.name,
        slug,
        description: data.description ?? null,
        status,
        active: status === ProductStatus.ACTIVE,
        featured: data.featured,
        brandId: data.brandId ?? null,
        categoryId: data.categoryId ?? null,
        taxCategory: data.taxCategory ?? null,
        seoTitle: data.seoTitle ?? null,
        seoDescription: data.seoDescription ?? null,
        publishedAt: status === ProductStatus.ACTIVE ? new Date() : null,
      },
    });

    if (defaultVariant) {
      await createVariantTx(tx, created.id, defaultVariant, authed.id);
    }

    return tx.product.findUniqueOrThrow({
      where: { id: created.id },
      include: productDetailInclude,
    });
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PRODUCT_CREATED,
      actorUserId: authed.id,
      entityType: "Product",
      entityId: product.id,
      metadata: {
        name: product.name,
        slug: product.slug,
        status: product.status,
        withDefaultVariant: Boolean(defaultVariant),
      },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
    db,
  );
  return product;
}

export async function updateProduct(
  actor: Actor,
  id: string,
  input: ProductUpdateInput & Meta,
  db: Db = prisma,
): Promise<ProductDetail> {
  const authed = requirePermission(actor, "catalog.write");
  const data = productUpdateSchema.parse(input);

  const updated = await db.$transaction(async (tx) => {
    const current = await tx.product.findUnique({ where: { id } });
    if (!current) throw new NotFoundError("Product", id);

    const nextSlug = data.slug !== undefined ? normalizeSlug(data.slug) : current.slug;
    if (nextSlug !== current.slug) await assertSlugFree(tx, nextSlug, id);
    await assertReferencesExist(tx, data.brandId, data.categoryId);

    const patch: Prisma.ProductUpdateInput = {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(nextSlug !== current.slug ? { slug: nextSlug } : {}),
      ...(data.description !== undefined ? { description: data.description || null } : {}),
      ...(data.featured !== undefined ? { featured: data.featured } : {}),
      ...(data.taxCategory !== undefined ? { taxCategory: data.taxCategory || null } : {}),
      ...(data.seoTitle !== undefined ? { seoTitle: data.seoTitle || null } : {}),
      ...(data.seoDescription !== undefined ? { seoDescription: data.seoDescription || null } : {}),
      ...(data.brandId !== undefined
        ? { brand: data.brandId ? { connect: { id: data.brandId } } : { disconnect: true } }
        : {}),
      ...(data.categoryId !== undefined
        ? {
            category: data.categoryId ? { connect: { id: data.categoryId } } : { disconnect: true },
          }
        : {}),
    };

    await tx.product.update({ where: { id }, data: patch });

    // Status changes go through a dedicated, validated path.
    if (data.status !== undefined && data.status !== current.status) {
      await applyStatusTransitionTx(tx, id, current.status, data.status);
    }

    return tx.product.findUniqueOrThrow({ where: { id }, include: productDetailInclude });
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PRODUCT_UPDATED,
      actorUserId: authed.id,
      entityType: "Product",
      entityId: id,
      metadata: { fields: Object.keys(data) },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
    db,
  );
  return updated;
}

const ALLOWED_TRANSITIONS: Record<ProductStatus, ProductStatus[]> = {
  [ProductStatus.DRAFT]: [ProductStatus.ACTIVE, ProductStatus.ARCHIVED],
  [ProductStatus.ACTIVE]: [ProductStatus.DRAFT, ProductStatus.ARCHIVED],
  [ProductStatus.ARCHIVED]: [ProductStatus.DRAFT, ProductStatus.ACTIVE],
};

async function applyStatusTransitionTx(
  tx: Pick<CatalogTxClient, "product" | "productVariant">,
  id: string,
  from: ProductStatus,
  to: ProductStatus,
): Promise<void> {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new InvalidStateTransitionError(`Cannot move a product from ${from} to ${to}.`);
  }

  if (to === ProductStatus.ACTIVE) {
    const activeVariants = await tx.productVariant.count({
      where: { productId: id, active: true },
    });
    if (activeVariants === 0) {
      throw new InvalidStateTransitionError(
        "A product needs at least one active variant before it can be ACTIVE.",
      );
    }
  }

  await tx.product.update({
    where: { id },
    data: {
      status: to,
      active: to === ProductStatus.ACTIVE,
      ...(to === ProductStatus.ACTIVE ? { publishedAt: new Date() } : {}),
    },
  });
}

export async function changeProductStatus(
  actor: Actor,
  id: string,
  status: ProductStatus,
  meta: Meta = {},
  db: Db = prisma,
): Promise<ProductDetail> {
  const authed = requirePermission(actor, "catalog.write");

  const result = await db.$transaction(async (tx) => {
    const current = await tx.product.findUnique({ where: { id }, select: { status: true } });
    if (!current) throw new NotFoundError("Product", id);
    if (current.status === status) {
      return tx.product.findUniqueOrThrow({ where: { id }, include: productDetailInclude });
    }
    await applyStatusTransitionTx(tx, id, current.status, status);
    return tx.product.findUniqueOrThrow({ where: { id }, include: productDetailInclude });
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PRODUCT_STATUS_CHANGED,
      actorUserId: authed.id,
      entityType: "Product",
      entityId: id,
      metadata: { newStatus: status },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
    db,
  );
  return result;
}

export async function deleteProductIfUnused(
  actor: Actor,
  id: string,
  meta: Meta = {},
  db: Db = prisma,
): Promise<void> {
  const authed = requirePermission(actor, "catalog.write");
  const product = await db.product.findUnique({
    where: { id },
    select: { id: true, name: true, _count: { select: { orderItems: true } } },
  });
  if (!product) throw new NotFoundError("Product", id);
  if (product._count.orderItems > 0) {
    throw new ReferentialIntegrityError(
      `Cannot delete "${product.name}" — it is referenced by ${product._count.orderItems} order line(s). Archive it instead.`,
    );
  }

  await db.product.delete({ where: { id } });
  await recordAudit(
    {
      action: AUDIT_ACTIONS.PRODUCT_STATUS_CHANGED,
      actorUserId: authed.id,
      entityType: "Product",
      entityId: id,
      metadata: { name: product.name, hardDeleted: true },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
    db,
  );
}
