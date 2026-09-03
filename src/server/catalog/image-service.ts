import type { PrismaClient, ProductImage } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { requirePermission, type AuthUser } from "@/server/auth/authorization";
import { recordAudit } from "@/server/audit/audit-service";
import { AUDIT_ACTIONS } from "@/server/audit/actions";
import { CatalogValidationError, NotFoundError } from "@/server/catalog/errors";
import { getObjectStorage } from "@/server/storage";
import {
  isAllowedImageType,
  isSafeStorageKey,
  productImageKey,
} from "@/server/storage/object-storage";

/**
 * Product image data foundation. The DB stores only a reference in
 * `ProductImage.url`:
 * - `storage:<key>` for objects we host (resolved through `ObjectStorage`);
 * - an absolute `https://` URL for externally hosted images (e.g. from import).
 * Binary data never touches PostgreSQL.
 */

type Db = Pick<PrismaClient, "product" | "productImage" | "productVariant" | "auditLog">;
type Actor = AuthUser | null | undefined;

export const MAX_IMAGE_BYTES = 5_000_000;
const STORAGE_PREFIX = "storage:";

interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AddImageInput extends Meta {
  storageKey?: string;
  externalUrl?: string;
  altText?: string;
  position?: number;
  isPrimary?: boolean;
  variantId?: string | null;
}

/** Turn a stored `ProductImage.url` reference into a browser-usable URL. */
export function resolveImageUrl(stored: string): string {
  if (stored.startsWith(STORAGE_PREFIX)) {
    return getObjectStorage().publicUrl(stored.slice(STORAGE_PREFIX.length));
  }
  return stored;
}

function normalizeReference(input: AddImageInput): string {
  if (input.storageKey) {
    if (!isSafeStorageKey(input.storageKey)) {
      throw new CatalogValidationError("Invalid storage key.");
    }
    return `${STORAGE_PREFIX}${input.storageKey}`;
  }
  if (input.externalUrl) {
    let url: URL;
    try {
      url = new URL(input.externalUrl);
    } catch {
      throw new CatalogValidationError("Image URL is not a valid URL.");
    }
    if (url.protocol !== "https:") {
      throw new CatalogValidationError("External image URLs must use https.");
    }
    return url.toString();
  }
  throw new CatalogValidationError("Provide either a storageKey or an externalUrl.");
}

export async function listProductImages(
  actor: Actor,
  productId: string,
  db: Db = prisma,
): Promise<(ProductImage & { resolvedUrl: string })[]> {
  requirePermission(actor, "catalog.read");
  const images = await db.productImage.findMany({
    where: { productId },
    orderBy: { position: "asc" },
  });
  return images.map((image) => ({ ...image, resolvedUrl: resolveImageUrl(image.url) }));
}

export async function addProductImage(
  actor: Actor,
  productId: string,
  input: AddImageInput,
  db: Db = prisma,
): Promise<ProductImage> {
  const authed = requirePermission(actor, "catalog.write");

  const product = await db.product.findUnique({ where: { id: productId }, select: { id: true } });
  if (!product) throw new NotFoundError("Product", productId);

  if (input.variantId) {
    const variant = await db.productVariant.findFirst({
      where: { id: input.variantId, productId },
      select: { id: true },
    });
    if (!variant) throw new CatalogValidationError("Variant does not belong to this product.");
  }

  const reference = normalizeReference(input);
  const altText = input.altText?.trim().slice(0, 300) || null;
  const count = await db.productImage.count({ where: { productId } });
  const isPrimary = input.isPrimary ?? count === 0;

  if (isPrimary) {
    await db.productImage.updateMany({ where: { productId }, data: { isPrimary: false } });
  }

  const image = await db.productImage.create({
    data: {
      productId,
      variantId: input.variantId ?? null,
      url: reference,
      altText,
      position: input.position ?? count,
      isPrimary,
    },
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PRODUCT_IMAGE_ADDED,
      actorUserId: authed.id,
      entityType: "Product",
      entityId: productId,
      metadata: { imageId: image.id, hosted: reference.startsWith(STORAGE_PREFIX), isPrimary },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
    db,
  );
  return image;
}

/** Validate + store an uploaded image, then attach it to the product. */
export async function uploadProductImage(
  actor: Actor,
  productId: string,
  file: { filename: string; contentType: string; bytes: Uint8Array } & Meta,
  db: Db = prisma,
): Promise<ProductImage> {
  requirePermission(actor, "catalog.write");
  if (!isAllowedImageType(file.contentType)) {
    throw new CatalogValidationError("Unsupported image type. Use JPEG, PNG, WebP, AVIF or GIF.");
  }
  if (file.bytes.byteLength === 0 || file.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new CatalogValidationError(`Image must be between 1 byte and ${MAX_IMAGE_BYTES} bytes.`);
  }

  const key = productImageKey(productId, file.filename);
  await getObjectStorage().put({ key, body: file.bytes, contentType: file.contentType });

  return addProductImage(
    actor,
    productId,
    { storageKey: key, ipAddress: file.ipAddress, userAgent: file.userAgent },
    db,
  );
}

export async function updateProductImage(
  actor: Actor,
  imageId: string,
  patch: { altText?: string; position?: number; isPrimary?: boolean } & Meta,
  db: Db = prisma,
): Promise<ProductImage> {
  const authed = requirePermission(actor, "catalog.write");
  const current = await db.productImage.findUnique({ where: { id: imageId } });
  if (!current) throw new NotFoundError("Image", imageId);

  if (patch.isPrimary === true) {
    await db.productImage.updateMany({
      where: { productId: current.productId },
      data: { isPrimary: false },
    });
  }

  const image = await db.productImage.update({
    where: { id: imageId },
    data: {
      ...(patch.altText !== undefined
        ? { altText: patch.altText.trim().slice(0, 300) || null }
        : {}),
      ...(patch.position !== undefined ? { position: patch.position } : {}),
      ...(patch.isPrimary !== undefined ? { isPrimary: patch.isPrimary } : {}),
    },
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PRODUCT_IMAGE_UPDATED,
      actorUserId: authed.id,
      entityType: "Product",
      entityId: current.productId,
      metadata: { imageId, fields: Object.keys(patch) },
      ipAddress: patch.ipAddress,
      userAgent: patch.userAgent,
    },
    db,
  );
  return image;
}

export async function removeProductImage(
  actor: Actor,
  imageId: string,
  meta: Meta = {},
  db: Db = prisma,
): Promise<void> {
  const authed = requirePermission(actor, "catalog.write");
  const image = await db.productImage.findUnique({ where: { id: imageId } });
  if (!image) throw new NotFoundError("Image", imageId);

  await db.productImage.delete({ where: { id: imageId } });

  if (image.url.startsWith(STORAGE_PREFIX)) {
    await getObjectStorage()
      .delete(image.url.slice(STORAGE_PREFIX.length))
      .catch((error: unknown) => {
        console.error("[image-service] failed to delete storage object:", error);
      });
  }

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PRODUCT_IMAGE_REMOVED,
      actorUserId: authed.id,
      entityType: "Product",
      entityId: image.productId,
      metadata: { imageId },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
    db,
  );
}
