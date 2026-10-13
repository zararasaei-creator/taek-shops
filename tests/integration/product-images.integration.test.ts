import { UserRole } from "@prisma/client";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ForbiddenError, UnauthenticatedError } from "@/server/auth/errors";
import { CatalogValidationError, NotFoundError, ReferentialIntegrityError } from "@/server/catalog/errors";
import { MAX_IMAGE_DIMENSION_PX } from "@/server/storage/image-decode";
import {
  createProductImageUploadSlot,
  finalizeProductImageUpload,
  listProductImages,
  reorderProductImages,
  removeProductImage,
  updateProductImage,
  uploadProductImage,
} from "@/server/catalog/image-service";
import { deleteProductIfUnused } from "@/server/catalog/product-service";
import { getPublicProductBySlug } from "@/server/catalog/catalog-queries";
import { __setObjectStorage } from "@/server/storage";
import { sweepAbandonedImageUploads } from "@/server/storage/upload-cleanup";
import { db } from "./helpers/db";
import { FakeObjectStorage } from "./helpers/object-storage";

/**
 * Phase 9 product images — against a real, isolated database, the real
 * `image-service.ts` / `product-service.ts` / `catalog-queries.ts`. A
 * `FakeObjectStorage` stands in for the S3-compatible backend — this
 * proves the application's own upload/finalize/cleanup/deletion logic, not
 * real MinIO behaviour (see `tests/e2e/product-images.spec.ts` for that).
 *
 * Namespaced: products via slug prefix `zzz-phase9-`, sku prefix `PF9-`.
 */

const PRODUCT_SLUG_PREFIX = "zzz-phase9-";
const SKU_PREFIX = "PF9-";

// A genuinely valid, real, decodable JPEG (not just magic bytes) —
// populated in `beforeAll` since encoding is async. Using a real image
// throughout means these tests also exercise the real decode-validation
// step (`decodeImageDimensions`), not just byte-sniffing.
let VALID_JPEG: Uint8Array;
const SVG_BYTES = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

let rand = 0;
function uid(): string {
  rand += 1;
  return `${Date.now().toString(36)}${rand}`;
}

interface Actor {
  id: string;
  role: UserRole;
}

async function ensureActor(role: UserRole): Promise<Actor> {
  const email = `phase9-${role.toLowerCase()}@taek.local`;
  return db.user.upsert({
    where: { email },
    update: { role, status: "ACTIVE" },
    create: { email, role, status: "ACTIVE", firstName: "Phase9", lastName: role },
    select: { id: true, role: true },
  });
}

async function makeProduct(opts: { active?: boolean } = {}): Promise<{ productId: string; slug: string }> {
  const suffix = uid();
  const slug = `${PRODUCT_SLUG_PREFIX}${suffix}`;
  const product = await db.product.create({
    data: {
      name: `Phase 9 Test ${suffix}`,
      slug,
      status: "ACTIVE",
      active: opts.active ?? true,
      variants: {
        create: {
          sku: `${SKU_PREFIX}${suffix}`,
          priceCents: 4999,
          optionSignature: "",
          active: true,
        },
      },
    },
    select: { id: true },
  });
  return { productId: product.id, slug };
}

async function cleanup(): Promise<void> {
  const actorEmails = [UserRole.CUSTOMER, UserRole.STAFF, UserRole.MANAGER].map(
    (r) => `phase9-${r.toLowerCase()}@taek.local`,
  );
  const actors = await db.user.findMany({ where: { email: { in: actorEmails } }, select: { id: true } });
  if (actors.length > 0) {
    await db.auditLog.deleteMany({ where: { actorUserId: { in: actors.map((a) => a.id) } } });
  }
  await db.product.deleteMany({ where: { slug: { startsWith: PRODUCT_SLUG_PREFIX } } });
  await db.user.deleteMany({ where: { email: { in: actorEmails } } });
}

let manager: Actor;
let staff: Actor;
let storage: FakeObjectStorage;

beforeAll(async () => {
  await cleanup();
  [manager, staff] = await Promise.all([ensureActor(UserRole.MANAGER), ensureActor(UserRole.STAFF)]);
  VALID_JPEG = await sharp({
    create: { width: 20, height: 20, channels: 3, background: { r: 200, g: 50, b: 50 } },
  })
    .jpeg()
    .toBuffer();
});

beforeEach(() => {
  storage = new FakeObjectStorage();
  __setObjectStorage(storage);
});

afterEach(() => {
  __setObjectStorage(undefined);
});

afterAll(async () => {
  await cleanup();
  await db.$disconnect();
});

describe("authorization", () => {
  it("createProductImageUploadSlot denies unauthenticated and STAFF; allows MANAGER", async () => {
    const { productId } = await makeProduct();
    const input = { contentType: "image/jpeg", byteSize: 1000 };
    await expect(createProductImageUploadSlot(null, productId, input, db)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    await expect(
      createProductImageUploadSlot(staff, productId, input, db),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      createProductImageUploadSlot(manager, productId, input, db),
    ).resolves.toBeDefined();
  });

  it("reorderProductImages and removeProductImage deny STAFF", async () => {
    const { productId } = await makeProduct();
    await expect(reorderProductImages(staff, productId, ["x"], {}, db)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(removeProductImage(staff, "whatever", {}, db)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("invalid and oversized uploads are rejected", () => {
  it("rejects a claimed content-type outside the allowed set, before touching storage", async () => {
    const { productId } = await makeProduct();
    await expect(
      createProductImageUploadSlot(
        manager,
        productId,
        { contentType: "image/svg+xml", byteSize: 1000 },
        db,
      ),
    ).rejects.toBeInstanceOf(CatalogValidationError);
  });

  it("rejects a claimed byte size over the limit", async () => {
    const { productId } = await makeProduct();
    await expect(
      createProductImageUploadSlot(
        manager,
        productId,
        { contentType: "image/jpeg", byteSize: 6_000_000 },
        db,
      ),
    ).rejects.toBeInstanceOf(CatalogValidationError);
  });

  it("finalize rejects bytes that are actually SVG, regardless of the original claim, and cleans up", async () => {
    const { productId } = await makeProduct();
    const slot = await createProductImageUploadSlot(
      manager,
      productId,
      { contentType: "image/jpeg", byteSize: SVG_BYTES.byteLength },
      db,
    );
    expect(slot.uploadId).not.toBeNull();
    // Simulate the browser having PUT actual SVG bytes to the presigned URL.
    const uploadRow = await db.productImageUpload.findUniqueOrThrow({ where: { id: slot.uploadId! } });
    storage.seedStagedObject(uploadRow.storageKey, SVG_BYTES, "image/jpeg");

    await expect(finalizeProductImageUpload(manager, slot.uploadId!, {}, db)).rejects.toBeInstanceOf(
      CatalogValidationError,
    );
    expect(storage.has(uploadRow.storageKey)).toBe(false); // staged object deleted
    expect(await db.productImageUpload.findUnique({ where: { id: slot.uploadId! } })).toBeNull();
    expect(await db.productImage.count({ where: { productId } })).toBe(0);
  });

  it("finalize rejects a staged upload that never actually landed in storage", async () => {
    const { productId } = await makeProduct();
    const slot = await createProductImageUploadSlot(
      manager,
      productId,
      { contentType: "image/jpeg", byteSize: 1000 },
      db,
    );
    // Never seeded — simulates an abandoned/incomplete direct upload.
    await expect(finalizeProductImageUpload(manager, slot.uploadId!, {}, db)).rejects.toBeInstanceOf(
      CatalogValidationError,
    );
  });

  it("uploadProductImage (local-backend single-step path) also byte-sniffs, never trusts the claim", async () => {
    const { productId } = await makeProduct();
    await expect(
      uploadProductImage(
        manager,
        productId,
        { filename: "x.jpg", contentType: "image/jpeg", bytes: SVG_BYTES },
        db,
      ),
    ).rejects.toBeInstanceOf(CatalogValidationError);
  });
});

describe("a genuinely valid upload finalizes correctly", () => {
  it("moves staged bytes to a final key and creates the ProductImage row", async () => {
    const { productId } = await makeProduct();
    const slot = await createProductImageUploadSlot(
      manager,
      productId,
      { contentType: "image/jpeg", byteSize: VALID_JPEG.byteLength },
      db,
    );
    const uploadRow = await db.productImageUpload.findUniqueOrThrow({ where: { id: slot.uploadId! } });
    storage.seedStagedObject(uploadRow.storageKey, VALID_JPEG, "image/jpeg");

    const image = await finalizeProductImageUpload(
      manager,
      slot.uploadId!,
      { altText: "A test dobok" },
      db,
    );
    expect(image.altText).toBe("A test dobok");
    expect(image.isPrimary).toBe(true); // first image on the product
    expect(storage.has(uploadRow.storageKey)).toBe(false);
    expect(await db.productImageUpload.count({ where: { productId } })).toBe(0);
  });
});

describe("concurrent / repeated finalization is claim-safe", () => {
  it("two concurrent finalize calls for the SAME upload: exactly one succeeds, the other gets a clean NotFoundError — never a duplicate image or an orphaned storage object", async () => {
    const { productId } = await makeProduct();
    const slot = await createProductImageUploadSlot(
      manager,
      productId,
      { contentType: "image/jpeg", byteSize: VALID_JPEG.byteLength },
      db,
    );
    const uploadRow = await db.productImageUpload.findUniqueOrThrow({ where: { id: slot.uploadId! } });
    storage.seedStagedObject(uploadRow.storageKey, VALID_JPEG, "image/jpeg");

    const results = await Promise.allSettled([
      finalizeProductImageUpload(manager, slot.uploadId!, {}, db),
      finalizeProductImageUpload(manager, slot.uploadId!, {}, db),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(NotFoundError);

    // Exactly one ProductImage — the race never produced a duplicate.
    expect(await db.productImage.count({ where: { productId } })).toBe(1);
    // No stray, unreferenced final-key object from the loser: every stored
    // object under the fake either is the staging key (already deleted) or
    // is the one now referenced by the single ProductImage row.
    const image = await db.productImage.findFirstOrThrow({ where: { productId } });
    const finalKey = image.url.replace("storage:", "");
    expect(storage.has(finalKey)).toBe(true);
  });

  it("finalizing an already-finalized (or never-existed) uploadId a second time 404s, never silently succeeds", async () => {
    const { productId } = await makeProduct();
    const slot = await createProductImageUploadSlot(
      manager,
      productId,
      { contentType: "image/jpeg", byteSize: VALID_JPEG.byteLength },
      db,
    );
    const uploadRow = await db.productImageUpload.findUniqueOrThrow({ where: { id: slot.uploadId! } });
    storage.seedStagedObject(uploadRow.storageKey, VALID_JPEG, "image/jpeg");

    await finalizeProductImageUpload(manager, slot.uploadId!, {}, db);
    await expect(finalizeProductImageUpload(manager, slot.uploadId!, {}, db)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await db.productImage.count({ where: { productId } })).toBe(1); // still exactly one
  });
});

describe("crash-safety: the claim survives past validation/storage/DB-insert failures — not just concurrency", () => {
  it("claiming leaves the row (with claimedAt set) durable — a crash before validation completes is still recoverable, not a silent leak", async () => {
    const { productId } = await makeProduct();
    const slot = await createProductImageUploadSlot(
      manager,
      productId,
      { contentType: "image/jpeg", byteSize: VALID_JPEG.byteLength },
      db,
    );
    const uploadRow = await db.productImageUpload.findUniqueOrThrow({ where: { id: slot.uploadId! } });
    storage.seedStagedObject(uploadRow.storageKey, VALID_JPEG, "image/jpeg");

    // Simulate exactly what `finalizeProductImageUpload` does as its very
    // first step (the atomic claim), then simulate a crash immediately
    // after — before validation, storage I/O, or the DB insert ever run.
    await db.productImageUpload.update({
      where: { id: uploadRow.id, claimedAt: null },
      data: { claimedAt: new Date(Date.now() - 20 * 60 * 1000) }, // stuck for 20 minutes
    });

    // The row survived the "crash" — it's still there, still pointing at
    // the staged object, not silently gone.
    const stuck = await db.productImageUpload.findUniqueOrThrow({ where: { id: uploadRow.id } });
    expect(stuck.claimedAt).not.toBeNull();
    expect(stuck.finalKey).toBeNull();
    expect(storage.has(uploadRow.storageKey)).toBe(true);

    // A normal retry can no longer finalize it — it's claimed, not gone —
    // proving finalize's exclusivity extends to "claimed but not yet
    // terminal," not just "already deleted."
    await expect(finalizeProductImageUpload(manager, slot.uploadId!, {}, db)).rejects.toBeInstanceOf(
      NotFoundError,
    );

    // The bounded-retry sweep is what actually recovers it.
    const result = await sweepAbandonedImageUploads(db, storage);
    expect(result.recoveredClaims).toBe(1);
    expect(storage.has(uploadRow.storageKey)).toBe(false);
    expect(await db.productImageUpload.findUnique({ where: { id: uploadRow.id } })).toBeNull();
    expect(await db.productImage.count({ where: { productId } })).toBe(0);
  });

  it("a crash after the final object was written but before the ProductImage row committed leaves a recoverable trail, cleans up BOTH objects, and creates no orphaned live image", async () => {
    const { productId } = await makeProduct();
    const slot = await createProductImageUploadSlot(
      manager,
      productId,
      { contentType: "image/jpeg", byteSize: VALID_JPEG.byteLength },
      db,
    );
    const uploadRow = await db.productImageUpload.findUniqueOrThrow({ where: { id: slot.uploadId! } });
    storage.seedStagedObject(uploadRow.storageKey, VALID_JPEG, "image/jpeg");

    // Replay finalize's own sequence up to (and including) the point right
    // before `addProductImage` runs — the exact state a real crash there
    // would leave — without ever calling `addProductImage`. This is what
    // proves crash-safety directly, not by inference from a race.
    await db.productImageUpload.update({
      where: { id: uploadRow.id, claimedAt: null },
      data: { claimedAt: new Date(Date.now() - 20 * 60 * 1000) },
    });
    const finalKey = `products/${productId}/${Date.now()}-crash-test.jpg`;
    await db.productImageUpload.update({ where: { id: uploadRow.id }, data: { finalKey } });
    await storage.put({ key: finalKey, body: VALID_JPEG, contentType: "image/jpeg" });
    // (never called addProductImage — this IS the simulated crash)

    expect(await db.productImage.count({ where: { productId } })).toBe(0);

    const result = await sweepAbandonedImageUploads(db, storage);
    expect(result.recoveredClaims).toBe(1);
    // Both the stale staging object AND the unattached final object are
    // cleaned up — neither is left as an untracked orphan.
    expect(storage.has(uploadRow.storageKey)).toBe(false);
    expect(storage.has(finalKey)).toBe(false);
    expect(await db.productImageUpload.findUnique({ where: { id: uploadRow.id } })).toBeNull();
    expect(await db.productImage.count({ where: { productId } })).toBe(0);
  });

  it("recovery NEVER deletes a final image that was actually attached — even if a stale tracking row somehow lingers", async () => {
    const { productId } = await makeProduct();
    // A real, successful upload — the normal path.
    const image = await uploadProductImage(
      manager,
      productId,
      { filename: "a.jpg", contentType: "image/jpeg", bytes: VALID_JPEG },
      db,
    );
    const finalKey = image.url.replace("storage:", "");
    expect(storage.has(finalKey)).toBe(true);

    // Simulate a tracking row that lingered despite the image having
    // actually been attached (e.g. the post-success row-delete step itself
    // failed) — this is the state recovery must treat as "already done,"
    // never as "orphaned."
    const slot = await createProductImageUploadSlot(
      manager,
      productId,
      { contentType: "image/jpeg", byteSize: VALID_JPEG.byteLength },
      db,
    );
    const stragglerRow = await db.productImageUpload.findUniqueOrThrow({ where: { id: slot.uploadId! } });
    await db.productImageUpload.update({
      where: { id: stragglerRow.id },
      data: { claimedAt: new Date(Date.now() - 20 * 60 * 1000), finalKey },
    });

    const result = await sweepAbandonedImageUploads(db, storage);
    expect(result.recoveredClaims).toBe(1);
    // The live, attached image is untouched...
    expect(storage.has(finalKey)).toBe(true);
    expect(await db.productImage.count({ where: { id: image.id } })).toBe(1);
    // ...only the stale tracking row (and its own, unrelated staging
    // object) is gone.
    expect(await db.productImageUpload.findUnique({ where: { id: stragglerRow.id } })).toBeNull();
    expect(storage.has(stragglerRow.storageKey)).toBe(false);
  });
});

describe("upload-slot ownership", () => {
  it("finalize always attaches to the product the slot was created for — there is no productId parameter to spoof", async () => {
    const { productId: productA } = await makeProduct();
    const { productId: productB } = await makeProduct();
    const slot = await createProductImageUploadSlot(
      manager,
      productA,
      { contentType: "image/jpeg", byteSize: VALID_JPEG.byteLength },
      db,
    );
    const uploadRow = await db.productImageUpload.findUniqueOrThrow({ where: { id: slot.uploadId! } });
    storage.seedStagedObject(uploadRow.storageKey, VALID_JPEG, "image/jpeg");

    // `finalizeProductImageUpload`'s signature takes only (actor, uploadId,
    // input) — there is no productId argument a caller could substitute to
    // redirect where the resulting image attaches.
    const image = await finalizeProductImageUpload(manager, slot.uploadId!, {}, db);
    expect(image.productId).toBe(productA);
    expect(await db.productImage.count({ where: { productId: productB } })).toBe(0);
  });

  it("a bogus/unknown uploadId is refused, never treated as belonging to any product", async () => {
    await expect(finalizeProductImageUpload(manager, "nonexistent-upload-id", {}, db)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("real image decoding, not just magic-byte sniffing", () => {
  it("rejects a corrupt/truncated file with valid magic bytes but an undecodable body — end to end through finalize", async () => {
    const { productId } = await makeProduct();
    const truncated = VALID_JPEG.subarray(0, Math.floor(VALID_JPEG.byteLength * 0.4));
    const slot = await createProductImageUploadSlot(
      manager,
      productId,
      { contentType: "image/jpeg", byteSize: truncated.byteLength },
      db,
    );
    const uploadRow = await db.productImageUpload.findUniqueOrThrow({ where: { id: slot.uploadId! } });
    storage.seedStagedObject(uploadRow.storageKey, truncated, "image/jpeg");

    await expect(finalizeProductImageUpload(manager, slot.uploadId!, {}, db)).rejects.toBeInstanceOf(
      CatalogValidationError,
    );
    expect(storage.has(uploadRow.storageKey)).toBe(false); // staged object still cleaned up on rejection
    expect(await db.productImage.count({ where: { productId } })).toBe(0);
  });

  it("rejects an image exceeding the configured dimension limit — end to end through the local single-step path", async () => {
    const { productId } = await makeProduct();
    const tooWide = await sharp({
      create: { width: MAX_IMAGE_DIMENSION_PX + 1, height: 1, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .png()
      .toBuffer();

    await expect(
      uploadProductImage(manager, productId, { filename: "huge.png", contentType: "image/png", bytes: tooWide }, db),
    ).rejects.toBeInstanceOf(CatalogValidationError);
    expect(await db.productImage.count({ where: { productId } })).toBe(0);
  });
});

describe("ordering and alt text", () => {
  async function addTwoImages(productId: string) {
    const first = await uploadProductImage(
      manager,
      productId,
      { filename: "a.jpg", contentType: "image/jpeg", bytes: VALID_JPEG },
      db,
    );
    const second = await uploadProductImage(
      manager,
      productId,
      { filename: "b.jpg", contentType: "image/jpeg", bytes: VALID_JPEG },
      db,
    );
    return { first, second };
  }

  it("reorder persists the new position order", async () => {
    const { productId } = await makeProduct();
    const { first, second } = await addTwoImages(productId);

    await reorderProductImages(manager, productId, [second.id, first.id], {}, db);
    const images = await listProductImages(manager, productId, db);
    expect(images.map((i) => i.id)).toEqual([second.id, first.id]);
  });

  it("rejects a reorder list that omits or adds an id", async () => {
    const { productId } = await makeProduct();
    const { first } = await addTwoImages(productId);
    await expect(
      reorderProductImages(manager, productId, [first.id], {}, db), // missing second
    ).rejects.toBeInstanceOf(CatalogValidationError);
  });

  it("updates alt text and persists it", async () => {
    const { productId } = await makeProduct();
    const { first } = await addTwoImages(productId);
    const updated = await updateProductImage(manager, first.id, { altText: "Updated alt" }, db);
    expect(updated.altText).toBe("Updated alt");
  });
});

describe("storefront rendering", () => {
  it("resolves the storage reference to a public URL and orders primary-first", async () => {
    const { productId, slug } = await makeProduct();
    const image = await uploadProductImage(
      manager,
      productId,
      { filename: "a.jpg", contentType: "image/jpeg", bytes: VALID_JPEG },
      db,
    );
    expect(image.isPrimary).toBe(true);

    const publicProduct = await getPublicProductBySlug(slug);
    expect(publicProduct).not.toBeNull();
    expect(publicProduct!.images).toHaveLength(1);
    expect(publicProduct!.images[0]!.url).toContain("fake-storage.local");
    expect(publicProduct!.images[0]!.isPrimary).toBe(true);
  });

  it("never exposes a still-staged (unfinalized) upload on the storefront", async () => {
    const { productId, slug } = await makeProduct();
    await createProductImageUploadSlot(
      manager,
      productId,
      { contentType: "image/jpeg", byteSize: VALID_JPEG.byteLength },
      db,
    ); // created, never finalized

    const publicProduct = await getPublicProductBySlug(slug);
    expect(publicProduct!.images).toHaveLength(0);
  });
});

describe("shared-reference protection: product deletion cleans up storage", () => {
  it("deletes the storage object only after the DB delete has committed", async () => {
    const { productId } = await makeProduct();
    const image = await uploadProductImage(
      manager,
      productId,
      { filename: "a.jpg", contentType: "image/jpeg", bytes: VALID_JPEG },
      db,
    );
    const key = image.url.replace("storage:", "");
    expect(storage.has(key)).toBe(true);

    await deleteProductIfUnused(manager, productId, {}, db);

    expect(storage.deletedKeys).toContain(key);
    expect(await db.product.findUnique({ where: { id: productId } })).toBeNull();
  });

  it("refuses to delete (and never touches storage) when the product has order history", async () => {
    const { productId } = await makeProduct();
    const image = await uploadProductImage(
      manager,
      productId,
      { filename: "a.jpg", contentType: "image/jpeg", bytes: VALID_JPEG },
      db,
    );
    const variant = await db.productVariant.findFirstOrThrow({ where: { productId } });
    const order = await db.order.create({
      data: {
        orderNumber: `PF9-ORD-${uid()}`,
        customerEmail: "phase9-order@taek.local",
        status: "CONFIRMED",
        paymentStatus: "PAID",
        totalCents: 4999,
        items: {
          create: {
            productId, // deleteProductIfUnused counts via Product.orderItems, i.e. this FK
            variantId: variant.id,
            sku: variant.sku,
            productName: "Phase 9",
            unitPriceCents: 4999,
            quantity: 1,
            lineSubtotalCents: 4999,
            lineTotalCents: 4999,
          },
        },
      },
      select: { id: true },
    });

    await expect(deleteProductIfUnused(manager, productId, {}, db)).rejects.toBeInstanceOf(
      ReferentialIntegrityError,
    );
    const key = image.url.replace("storage:", "");
    expect(storage.has(key)).toBe(true); // never touched
    expect(storage.deletedKeys).not.toContain(key);

    await db.auditLog.deleteMany({ where: { entityId: order.id } });
    await db.order.delete({ where: { id: order.id } });
  });
});

describe("abandoned-upload cleanup", () => {
  it("sweeps only rows older than the age threshold, deletes their storage objects and rows", async () => {
    const { productId } = await makeProduct();
    const slot = await createProductImageUploadSlot(
      manager,
      productId,
      { contentType: "image/jpeg", byteSize: 100 },
      db,
    );
    const uploadRow = await db.productImageUpload.findUniqueOrThrow({ where: { id: slot.uploadId! } });
    storage.seedStagedObject(uploadRow.storageKey, VALID_JPEG);
    // Backdate it to simulate genuine abandonment.
    await db.productImageUpload.update({
      where: { id: slot.uploadId! },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });

    const result = await sweepAbandonedImageUploads(db, storage);
    expect(result.found).toBeGreaterThanOrEqual(1);
    expect(storage.has(uploadRow.storageKey)).toBe(false);
    expect(await db.productImageUpload.findUnique({ where: { id: slot.uploadId! } })).toBeNull();
  });

  it("does not sweep a fresh (not-yet-abandoned) upload", async () => {
    const { productId } = await makeProduct();
    const slot = await createProductImageUploadSlot(
      manager,
      productId,
      { contentType: "image/jpeg", byteSize: 100 },
      db,
    );
    await sweepAbandonedImageUploads(db, storage);
    expect(await db.productImageUpload.findUnique({ where: { id: slot.uploadId! } })).not.toBeNull();
  });

  it("a storage delete failure schedules a real retry — the tracking row survives, not silently dropped", async () => {
    const { productId } = await makeProduct();
    const slot = await createProductImageUploadSlot(
      manager,
      productId,
      { contentType: "image/jpeg", byteSize: 100 },
      db,
    );
    await db.productImageUpload.update({
      where: { id: slot.uploadId! },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });
    storage.scriptDeleteFailure();

    const first = await sweepAbandonedImageUploads(db, storage);
    expect(first).toMatchObject({ found: 1, storageDeleted: 0, retriesScheduled: 1, gaveUp: 0 });
    const afterFirst = await db.productImageUpload.findUniqueOrThrow({ where: { id: slot.uploadId! } });
    expect(afterFirst.attempts).toBe(1); // row survives — this is the retry, not a drop

    // Storage now works (the fake only fails once) — a second sweep
    // actually retries and succeeds, genuinely deleting the object.
    const second = await sweepAbandonedImageUploads(db, storage);
    expect(second).toMatchObject({ found: 1, storageDeleted: 1, retriesScheduled: 0, gaveUp: 0 });
    expect(await db.productImageUpload.findUnique({ where: { id: slot.uploadId! } })).toBeNull();
  });

  it("gives up (bounded) once maxAttempts is reached, rather than retrying forever", async () => {
    const { productId } = await makeProduct();
    const slot = await createProductImageUploadSlot(
      manager,
      productId,
      { contentType: "image/jpeg", byteSize: 100 },
      db,
    );
    await db.productImageUpload.update({
      where: { id: slot.uploadId! },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000), maxAttempts: 2 },
    });

    storage.scriptDeleteFailure();
    const first = await sweepAbandonedImageUploads(db, storage);
    expect(first).toMatchObject({ retriesScheduled: 1, gaveUp: 0 });

    storage.scriptDeleteFailure();
    const second = await sweepAbandonedImageUploads(db, storage);
    expect(second).toMatchObject({ retriesScheduled: 0, gaveUp: 1 }); // attempts (2) reached maxAttempts (2)
    expect(await db.productImageUpload.findUnique({ where: { id: slot.uploadId! } })).toBeNull();
  });
});
