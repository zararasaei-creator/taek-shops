import { Prisma, type PrismaClient, type ProductImage } from "@prisma/client";

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
  stagingImageKey,
} from "@/server/storage/object-storage";
import { sniffImageFormat } from "@/server/storage/image-sniff";
import { decodeImageDimensions } from "@/server/storage/image-decode";

/**
 * Product image data foundation. The DB stores only a reference in
 * `ProductImage.url`:
 * - `storage:<key>` for objects we host (resolved through `ObjectStorage`);
 * - an absolute `https://` URL for externally hosted images (e.g. from import).
 * Binary data never touches PostgreSQL.
 *
 * Two upload paths (Phase 9), both ending at the same `addProductImage`:
 * - **Local filesystem backend** (`LocalObjectStorage`, no direct-upload
 *   support): `uploadProductImage` — server receives the bytes directly in
 *   one request, validates them (byte-sniffed format, size), stores them,
 *   and creates the `ProductImage` row synchronously. No staging state.
 * - **S3-compatible backend** (real S3 or local MinIO): the browser uploads
 *   directly to storage via a short-lived presigned URL
 *   (`createProductImageUploadSlot`), bypassing this server for the bytes.
 *   Because this server never sees those bytes in transit, they are staged
 *   under a `staging/` key — never exposed to the storefront or admin image
 *   list (`listProductImages` only ever reads `ProductImage`, never
 *   `ProductImageUpload`) — until `finalizeProductImageUpload` fetches them
 *   back, verifies the ACTUAL bytes (never the claimed content-type), and
 *   only then creates the real `ProductImage` row at a final key. An upload
 *   slot that's never finalized is cleaned up by
 *   `src/server/storage/upload-cleanup.ts` (`npm run
 *   images:cleanup-uploads`), never left behind indefinitely.
 */

type Db = Pick<
  PrismaClient,
  "product" | "productImage" | "productImageUpload" | "productVariant" | "auditLog" | "$transaction"
>;
type Actor = AuthUser | null | undefined;

export const MAX_IMAGE_BYTES = 5_000_000;
const STORAGE_PREFIX = "storage:";

/** The object-storage key backing a `ProductImage.url` reference, or `null` for an external URL. */
function storageKeyFromReference(url: string): string | null {
  return url.startsWith(STORAGE_PREFIX) ? url.slice(STORAGE_PREFIX.length) : null;
}

/** Prisma's "no record matched the where clause" error — used as an atomic-claim signal below. */
function isRecordNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025";
}

/**
 * Best-effort delete the storage objects behind a set of `ProductImage.url`
 * references (external `https://` references are skipped — nothing we
 * host). For callers that hard-delete a `Product`/`ProductVariant` row: the
 * DB-level cascade (`onDelete: Cascade` on `ProductImage.product`) removes
 * the `ProductImage` rows themselves, but a Postgres cascade cannot reach
 * into object storage — call this BEFORE the delete (to still have the
 * `url` references) and only after the delete has actually succeeded, so a
 * failed/rolled-back delete never orphans live storage objects for rows
 * that still exist.
 */
export async function deleteImageStorageObjectsForReferences(urls: string[]): Promise<void> {
  const storage = getObjectStorage();
  for (const url of urls) {
    const key = storageKeyFromReference(url);
    if (!key) continue;
    await storage.delete(key).catch((error: unknown) => {
      console.error("[image-service] failed to delete storage object during cascade cleanup:", error);
    });
  }
}

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

/**
 * Validate + store an uploaded image in one synchronous step, then attach
 * it to the product. Used by the local-filesystem backend, which has no
 * direct-upload endpoint (`createSignedUpload` returns `null`) — the whole
 * upload happens as one request through this server, so there's no
 * out-of-band gap to stage against. The claimed `contentType` is NEVER
 * trusted: the actual bytes are sniffed and must genuinely match a
 * supported format (see `sniffImageFormat`), or the upload is rejected
 * before anything is written to storage.
 */
export async function uploadProductImage(
  actor: Actor,
  productId: string,
  file: { filename: string; contentType: string; bytes: Uint8Array } & Meta,
  db: Db = prisma,
): Promise<ProductImage> {
  requirePermission(actor, "catalog.write");
  if (file.bytes.byteLength === 0 || file.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new CatalogValidationError(`Image must be between 1 byte and ${MAX_IMAGE_BYTES} bytes.`);
  }
  const sniffed = sniffImageFormat(file.bytes);
  if (!sniffed) {
    throw new CatalogValidationError(
      "Unsupported or invalid image file. Use JPEG, PNG, WebP, AVIF or GIF (SVG is not accepted).",
    );
  }
  // Magic bytes only prove the header looks right — decode for real so a
  // truncated/corrupt file (valid header, garbage body) and a
  // decompression-bomb-style oversized image are both caught, not just an
  // unusual format.
  if (!(await decodeImageDimensions(file.bytes))) {
    throw new CatalogValidationError(
      "Image could not be decoded, or its dimensions exceed the allowed limit.",
    );
  }

  const key = productImageKey(productId, file.filename);
  await getObjectStorage().put({ key, body: file.bytes, contentType: sniffed });

  return addProductImage(
    actor,
    productId,
    { storageKey: key, ipAddress: file.ipAddress, userAgent: file.userAgent },
    db,
  );
}

// ---------------------------------------------------------------------------
// Staged direct upload (S3-compatible backend) — Phase 9
// ---------------------------------------------------------------------------

export interface CreateUploadSlotInput extends Meta {
  contentType: string;
  /** The browser's claimed byte size — a cheap early check only; the real check is at finalize. */
  byteSize: number;
  variantId?: string | null;
}

export interface UploadSlot {
  /** `null` when the backend has no direct-upload support — see `signedUpload`. */
  uploadId: string | null;
  /** `null` means the backend doesn't support direct upload; call `uploadProductImage` instead. */
  signedUpload: { url: string; method: "PUT" | "POST"; headers?: Record<string, string> } | null;
}

/**
 * Create a staged upload slot. Authorization, product/variant ownership,
 * and a cheap claim-level type/size check happen here — the actual,
 * authoritative validation happens at `finalizeProductImageUpload`, against
 * the real bytes, never this claim.
 */
export async function createProductImageUploadSlot(
  actor: Actor,
  productId: string,
  input: CreateUploadSlotInput,
  db: Db = prisma,
): Promise<UploadSlot> {
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
  if (!isAllowedImageType(input.contentType)) {
    throw new CatalogValidationError("Unsupported image type. Use JPEG, PNG, WebP, AVIF or GIF.");
  }
  if (input.byteSize <= 0 || input.byteSize > MAX_IMAGE_BYTES) {
    throw new CatalogValidationError(`Image must be between 1 byte and ${MAX_IMAGE_BYTES} bytes.`);
  }

  const key = stagingImageKey(productId);
  const signed = await getObjectStorage().createSignedUpload(key, input.contentType);
  if (!signed) {
    // The local-filesystem backend has no direct-upload endpoint — there is
    // nothing to stage. The caller falls back to `uploadProductImage`
    // instead, which validates and stores the bytes in one synchronous
    // request; no `ProductImageUpload` tracking row is created for this
    // path (there's no out-of-band gap for it to ever need recovering
    // from), which is also why `scripts/cleanup-image-uploads.ts` only
    // needs to handle the S3-compatible backend.
    return { uploadId: null, signedUpload: null };
  }

  const upload = await db.productImageUpload.create({
    data: {
      productId,
      variantId: input.variantId ?? null,
      storageKey: key,
      claimedContentType: input.contentType,
      createdById: authed.id,
    },
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PRODUCT_IMAGE_UPLOAD_CREATED,
      actorUserId: authed.id,
      entityType: "Product",
      entityId: productId,
      metadata: { uploadId: upload.id },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
    db,
  );

  return {
    uploadId: upload.id,
    signedUpload: { url: signed.url, method: signed.method, headers: signed.headers },
  };
}

export interface FinalizeUploadInput extends Meta {
  altText?: string;
  position?: number;
  isPrimary?: boolean;
}

/**
 * Finalize a staged upload: fetch the actual uploaded bytes back from
 * storage, verify them for real (size, byte-sniffed format, and a genuine
 * decode with dimension limits — the claimed content-type from slot
 * creation is never trusted here either), and only on success move them to
 * a final key and create the `ProductImage` row. On any failure the staged
 * object is removed too — nothing invalid is ever left reachable or
 * referenced.
 *
 * **Concurrency-safe AND crash-safe by construction**: the very first thing
 * this does is atomically CLAIM the upload row via a conditional UPDATE
 * (`claimedAt: null` → now), not a delete. Prisma throws `P2025` if another
 * call already claimed or finalized it, which becomes a clean
 * `NotFoundError` here, before any storage I/O happens — so two concurrent
 * (or accidentally repeated) calls for the same `uploadId` can never both
 * proceed. Unlike a delete-based claim, though, the row deliberately
 * SURVIVES: it remains this upload's only durable recovery record for the
 * rest of this call. If the process crashes anywhere after the claim and
 * before a genuine terminal state below, `sweepAbandonedImageUploads`
 * (`src/server/storage/upload-cleanup.ts`) can still find and recover it —
 * a crash here is a leftover, recoverable row, never a silent, permanently
 * untracked storage leak. `finalKey` is written to the same row just
 * before the validated bytes are written to their final storage key, for
 * the same reason: it lets the sweep tell "wrote the final object but
 * never attached it" apart from "never got that far," and — critically —
 * apart from "already succeeded," so recovery can never delete a live,
 * attached image. The `ProductImage` insert and the tracking-row removal
 * happen in one transaction: either both commit, or the row survives (with
 * `finalKey` set) as exactly the state the sweep knows how to recover.
 */
export async function finalizeProductImageUpload(
  actor: Actor,
  uploadId: string,
  input: FinalizeUploadInput = {},
  db: Db = prisma,
): Promise<ProductImage> {
  const authed = requirePermission(actor, "catalog.write");

  let upload: Awaited<ReturnType<Db["productImageUpload"]["update"]>>;
  try {
    upload = await db.productImageUpload.update({
      where: { id: uploadId, claimedAt: null },
      data: { claimedAt: new Date() },
    });
  } catch (error) {
    if (isRecordNotFound(error)) throw new NotFoundError("Upload", uploadId);
    throw error;
  }

  const storage = getObjectStorage();
  const object = await storage.get(upload.storageKey);

  async function reject(reason: string): Promise<never> {
    await storage.delete(upload.storageKey).catch((error: unknown) => {
      console.error("[image-service] failed to delete rejected staged object:", error);
    });
    await db.productImageUpload.delete({ where: { id: upload.id } }).catch((error: unknown) => {
      if (!isRecordNotFound(error)) {
        console.error("[image-service] failed to remove rejected upload row:", error);
      }
    });
    await recordAudit(
      {
        action: AUDIT_ACTIONS.PRODUCT_IMAGE_UPLOAD_REJECTED,
        actorUserId: authed.id,
        entityType: "Product",
        entityId: upload.productId,
        metadata: { uploadId, reason },
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      },
      db,
    );
    throw new CatalogValidationError(reason);
  }

  if (!object) {
    await reject("Upload not found in storage — it may not have completed yet.");
  }
  if (object!.body.byteLength === 0 || object!.body.byteLength > MAX_IMAGE_BYTES) {
    await reject(`Image must be between 1 byte and ${MAX_IMAGE_BYTES} bytes.`);
  }
  const sniffed = sniffImageFormat(object!.body);
  if (!sniffed) {
    await reject(
      "Unsupported or invalid image file. Use JPEG, PNG, WebP, AVIF or GIF (SVG is not accepted).",
    );
  }
  // Authoritative check: genuinely decode the bytes, catching a corrupt/
  // truncated body (valid magic bytes, garbage payload) and enforcing a
  // real dimension/pixel-count limit — sniffing alone cannot do either.
  if (!(await decodeImageDimensions(object!.body))) {
    await reject("Image could not be decoded, or its dimensions exceed the allowed limit.");
  }

  const finalKey = productImageKey(upload.productId, `file.${sniffed!.split("/")[1]}`);

  // Durable marker, written BEFORE the storage write it describes — see
  // the module comment above for why this is the crash-recovery hinge.
  await db.productImageUpload.update({ where: { id: upload.id }, data: { finalKey } });

  await storage.put({ key: finalKey, body: object!.body, contentType: sniffed! });

  // Atomic: the ProductImage row and the tracking-row removal both commit,
  // or neither does. A rollback here leaves exactly the recoverable state
  // described above — never a half-attached image.
  const image = await db.$transaction(async (tx) => {
    const created = await addProductImage(
      actor,
      upload.productId,
      {
        storageKey: finalKey,
        variantId: upload.variantId,
        altText: input.altText,
        position: input.position,
        isPrimary: input.isPrimary,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      },
      tx as unknown as Db,
    );
    await tx.productImageUpload.delete({ where: { id: upload.id } });
    return created;
  });

  await storage.delete(upload.storageKey).catch((error: unknown) => {
    // Non-fatal: an orphaned staging object is swept later; the finalized
    // image at `finalKey` is already safely stored and attached either way.
    console.error("[image-service] failed to delete staged object after finalize:", error);
  });

  return image;
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

  const storageKey = storageKeyFromReference(image.url);
  if (storageKey) {
    await getObjectStorage()
      .delete(storageKey)
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

/**
 * Reorder a product's images in one call — `orderedImageIds` is the full
 * desired order, every id must already belong to this exact product
 * (ownership enforced: an id for another product's image, or a stale/
 * unknown id, fails the whole call rather than silently reordering a
 * partial/wrong set).
 */
export async function reorderProductImages(
  actor: Actor,
  productId: string,
  orderedImageIds: string[],
  meta: Meta = {},
  db: Db = prisma,
): Promise<void> {
  const authed = requirePermission(actor, "catalog.write");
  if (orderedImageIds.length === 0) return;

  const existing = await db.productImage.findMany({
    where: { productId },
    select: { id: true },
  });
  const existingIds = new Set(existing.map((i) => i.id));
  const requestedIds = new Set(orderedImageIds);
  if (
    orderedImageIds.length !== existingIds.size ||
    orderedImageIds.some((id) => !existingIds.has(id)) ||
    existing.some((i) => !requestedIds.has(i.id))
  ) {
    throw new CatalogValidationError(
      "The reorder list must contain exactly this product's current images, no more and no fewer.",
    );
  }

  await db.$transaction(
    orderedImageIds.map((id, position) => db.productImage.update({ where: { id }, data: { position } })),
  );

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PRODUCT_IMAGE_REORDERED,
      actorUserId: authed.id,
      entityType: "Product",
      entityId: productId,
      metadata: { imageIds: orderedImageIds },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
    db,
  );
}
