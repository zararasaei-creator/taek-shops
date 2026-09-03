import type { Category, Prisma, PrismaClient } from "@prisma/client";

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
import { normalizeSlug } from "@/server/catalog/slug";
import {
  categoryCreateSchema,
  categoryUpdateSchema,
  type CategoryCreateInput,
  type CategoryUpdateInput,
} from "@/lib/validation/catalog";

/**
 * Category administration. Categories form a tree via `parentId`. Cycles are
 * rejected; deletion is blocked while products reference the category.
 */

type Db = Pick<PrismaClient, "category" | "product" | "auditLog">;
type Actor = AuthUser | null | undefined;

interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

async function assertSlugFree(db: Db, slug: string, exceptId?: string): Promise<void> {
  const existing = await db.category.findUnique({ where: { slug }, select: { id: true } });
  if (existing && existing.id !== exceptId) {
    throw new ConflictError(`A category with the slug "${slug}" already exists.`);
  }
}

async function assertParentValid(
  db: Db,
  categoryId: string | null,
  parentId: string | null,
): Promise<void> {
  if (!parentId) return;
  if (parentId === categoryId) {
    throw new CatalogValidationError("A category cannot be its own parent.");
  }
  // Walk up the ancestry; reject if we reach `categoryId` (would create a cycle).
  let cursor: string | null = parentId;
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const node: { parentId: string | null } | null = await db.category.findUnique({
      where: { id: cursor },
      select: { parentId: true },
    });
    if (!node) throw new NotFoundError("Parent category", parentId);
    if (categoryId && node.parentId === categoryId) {
      throw new CatalogValidationError("Moving this category there would create a cycle.");
    }
    cursor = node.parentId;
  }
}

export async function listCategories(
  actor: Actor,
  options: { includeInactive?: boolean } = {},
  db: Db = prisma,
): Promise<Category[]> {
  requirePermission(actor, "catalog.read");
  return db.category.findMany({
    where: options.includeInactive ? {} : { active: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}

export async function getCategory(actor: Actor, id: string, db: Db = prisma): Promise<Category> {
  requirePermission(actor, "catalog.read");
  const category = await db.category.findUnique({ where: { id } });
  if (!category) throw new NotFoundError("Category", id);
  return category;
}

export async function createCategory(
  actor: Actor,
  input: CategoryCreateInput & Meta,
  db: Db = prisma,
): Promise<Category> {
  const authed = requirePermission(actor, "catalog.write");
  const data = categoryCreateSchema.parse(input);
  const slug = normalizeSlug(data.slug ?? data.name);

  await assertSlugFree(db, slug);
  await assertParentValid(db, null, data.parentId ?? null);

  const category = await db.category.create({
    data: {
      name: data.name,
      slug,
      description: data.description ?? null,
      parentId: data.parentId ?? null,
      sortOrder: data.sortOrder,
      active: data.active,
    },
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.CATEGORY_CREATED,
      actorUserId: authed.id,
      entityType: "Category",
      entityId: category.id,
      metadata: { name: category.name, slug: category.slug, parentId: category.parentId },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
    db,
  );
  return category;
}

export async function updateCategory(
  actor: Actor,
  id: string,
  input: CategoryUpdateInput & Meta,
  db: Db = prisma,
): Promise<Category> {
  const authed = requirePermission(actor, "catalog.write");
  const data = categoryUpdateSchema.parse(input);

  const current = await db.category.findUnique({ where: { id } });
  if (!current) throw new NotFoundError("Category", id);

  const nextSlug = data.slug !== undefined ? normalizeSlug(data.slug) : current.slug;
  if (nextSlug !== current.slug) await assertSlugFree(db, nextSlug, id);

  if (data.parentId !== undefined) {
    await assertParentValid(db, id, data.parentId);
  }

  const patch: Prisma.CategoryUpdateInput = {
    ...(data.name !== undefined ? { name: data.name } : {}),
    ...(nextSlug !== current.slug ? { slug: nextSlug } : {}),
    ...(data.description !== undefined ? { description: data.description || null } : {}),
    ...(data.parentId !== undefined
      ? { parent: data.parentId ? { connect: { id: data.parentId } } : { disconnect: true } }
      : {}),
    ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
    ...(data.active !== undefined ? { active: data.active } : {}),
  };

  const category = await db.category.update({ where: { id }, data: patch });

  await recordAudit(
    {
      action:
        data.active === false ? AUDIT_ACTIONS.CATEGORY_ARCHIVED : AUDIT_ACTIONS.CATEGORY_UPDATED,
      actorUserId: authed.id,
      entityType: "Category",
      entityId: id,
      metadata: { changed: Object.keys(patch) },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
    db,
  );
  return category;
}

export async function archiveCategory(
  actor: Actor,
  id: string,
  meta: Meta = {},
  db: Db = prisma,
): Promise<Category> {
  return updateCategory(actor, id, { active: false, ...meta }, db);
}

export async function deleteCategoryIfUnused(
  actor: Actor,
  id: string,
  meta: Meta = {},
  db: Db = prisma,
): Promise<void> {
  const authed = requirePermission(actor, "catalog.write");
  const category = await db.category.findUnique({
    where: { id },
    select: { id: true, name: true },
  });
  if (!category) throw new NotFoundError("Category", id);

  const [products, children] = await Promise.all([
    db.product.count({ where: { categoryId: id } }),
    db.category.count({ where: { parentId: id } }),
  ]);
  if (products > 0 || children > 0) {
    throw new ReferentialIntegrityError(
      `Cannot delete category "${category.name}" — ${products} product(s) and ${children} sub-categor(y/ies) reference it. Deactivate it instead.`,
    );
  }

  await db.category.delete({ where: { id } });
  await recordAudit(
    {
      action: AUDIT_ACTIONS.CATEGORY_ARCHIVED,
      actorUserId: authed.id,
      entityType: "Category",
      entityId: id,
      metadata: { name: category.name, hardDeleted: true },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
    db,
  );
}
