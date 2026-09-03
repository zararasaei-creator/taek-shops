import type { Brand, Prisma, PrismaClient } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { requirePermission, type AuthUser } from "@/server/auth/authorization";
import { recordAudit } from "@/server/audit/audit-service";
import { AUDIT_ACTIONS } from "@/server/audit/actions";
import { ConflictError, NotFoundError, ReferentialIntegrityError } from "@/server/catalog/errors";
import { normalizeSlug } from "@/server/catalog/slug";
import {
  brandCreateSchema,
  brandUpdateSchema,
  type BrandCreateInput,
  type BrandUpdateInput,
} from "@/lib/validation/catalog";

/**
 * Brand administration. `Brand` remains its own normalised model; it is never
 * collapsed into a `Product.brand` string.
 */

type Db = Pick<PrismaClient, "brand" | "product" | "auditLog">;
type Actor = AuthUser | null | undefined;

interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

async function assertSlugFree(db: Db, slug: string, exceptId?: string): Promise<void> {
  const existing = await db.brand.findUnique({ where: { slug }, select: { id: true } });
  if (existing && existing.id !== exceptId) {
    throw new ConflictError(`A brand with the slug "${slug}" already exists.`);
  }
}

async function assertNameFree(db: Db, name: string, exceptId?: string): Promise<void> {
  const existing = await db.brand.findUnique({ where: { name }, select: { id: true } });
  if (existing && existing.id !== exceptId) {
    throw new ConflictError(`A brand named "${name}" already exists.`);
  }
}

export async function listBrands(
  actor: Actor,
  options: { includeInactive?: boolean } = {},
  db: Db = prisma,
): Promise<Brand[]> {
  requirePermission(actor, "catalog.read");
  return db.brand.findMany({
    where: options.includeInactive ? {} : { active: true },
    orderBy: { name: "asc" },
  });
}

export async function getBrand(actor: Actor, id: string, db: Db = prisma): Promise<Brand> {
  requirePermission(actor, "catalog.read");
  const brand = await db.brand.findUnique({ where: { id } });
  if (!brand) throw new NotFoundError("Brand", id);
  return brand;
}

export async function createBrand(
  actor: Actor,
  input: BrandCreateInput & Meta,
  db: Db = prisma,
): Promise<Brand> {
  const authed = requirePermission(actor, "catalog.write");
  const data = brandCreateSchema.parse(input);
  const slug = normalizeSlug(data.slug ?? data.name);

  await assertNameFree(db, data.name);
  await assertSlugFree(db, slug);

  const brand = await db.brand.create({
    data: {
      name: data.name,
      slug,
      description: data.description ?? null,
      active: data.active,
    },
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.BRAND_CREATED,
      actorUserId: authed.id,
      entityType: "Brand",
      entityId: brand.id,
      metadata: { name: brand.name, slug: brand.slug },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
    db,
  );
  return brand;
}

export async function updateBrand(
  actor: Actor,
  id: string,
  input: BrandUpdateInput & Meta,
  db: Db = prisma,
): Promise<Brand> {
  const authed = requirePermission(actor, "catalog.write");
  const data = brandUpdateSchema.parse(input);

  const current = await db.brand.findUnique({ where: { id } });
  if (!current) throw new NotFoundError("Brand", id);

  const nextSlug =
    data.slug !== undefined
      ? normalizeSlug(data.slug)
      : data.name !== undefined && data.name !== current.name
        ? current.slug // keep an explicit slug stable on rename
        : current.slug;

  if (data.name !== undefined && data.name !== current.name)
    await assertNameFree(db, data.name, id);
  if (nextSlug !== current.slug) await assertSlugFree(db, nextSlug, id);

  const patch: Prisma.BrandUpdateInput = {
    ...(data.name !== undefined ? { name: data.name } : {}),
    ...(nextSlug !== current.slug ? { slug: nextSlug } : {}),
    ...(data.description !== undefined ? { description: data.description || null } : {}),
    ...(data.active !== undefined ? { active: data.active } : {}),
  };

  const brand = await db.brand.update({ where: { id }, data: patch });

  await recordAudit(
    {
      action: data.active === false ? AUDIT_ACTIONS.BRAND_ARCHIVED : AUDIT_ACTIONS.BRAND_UPDATED,
      actorUserId: authed.id,
      entityType: "Brand",
      entityId: id,
      metadata: { changed: Object.keys(patch) },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
    db,
  );
  return brand;
}

/**
 * Deactivate a brand. Brands are never hard-deleted while products reference
 * them; deactivation keeps the reference intact and hides the brand from
 * selection lists.
 */
export async function archiveBrand(
  actor: Actor,
  id: string,
  meta: Meta = {},
  db: Db = prisma,
): Promise<Brand> {
  return updateBrand(actor, id, { active: false, ...meta }, db);
}

/** Hard delete — only permitted when nothing references the brand. */
export async function deleteBrandIfUnused(
  actor: Actor,
  id: string,
  meta: Meta = {},
  db: Db = prisma,
): Promise<void> {
  const authed = requirePermission(actor, "catalog.write");
  const brand = await db.brand.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!brand) throw new NotFoundError("Brand", id);

  const referencing = await db.product.count({ where: { brandId: id } });
  if (referencing > 0) {
    throw new ReferentialIntegrityError(
      `Cannot delete brand "${brand.name}" — ${referencing} product(s) reference it. Deactivate it instead.`,
    );
  }

  await db.brand.delete({ where: { id } });
  await recordAudit(
    {
      action: AUDIT_ACTIONS.BRAND_ARCHIVED,
      actorUserId: authed.id,
      entityType: "Brand",
      entityId: id,
      metadata: { name: brand.name, hardDeleted: true },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
    db,
  );
}
