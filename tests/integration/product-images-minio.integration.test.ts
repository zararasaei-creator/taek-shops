import { CreateBucketCommand, PutBucketPolicyCommand, S3Client } from "@aws-sdk/client-s3";
import { UserRole } from "@prisma/client";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CatalogValidationError } from "@/server/catalog/errors";
import {
  createProductImageUploadSlot,
  finalizeProductImageUpload,
} from "@/server/catalog/image-service";
import { getPublicProductBySlug } from "@/server/catalog/catalog-queries";
import { __setObjectStorage } from "@/server/storage";
import { S3ObjectStorage } from "@/server/storage/s3-object-storage";
import { sweepAbandonedImageUploads } from "@/server/storage/upload-cleanup";
import { db } from "./helpers/db";

/**
 * Real MinIO verification (Phase 9). Unlike
 * `product-images.integration.test.ts` (a `FakeObjectStorage` in-memory
 * double — proves the application's own orchestration logic) and
 * `tests/e2e/product-images.spec.ts` (a real browser, but the local-
 * filesystem storage backend — no direct-upload endpoint), this file talks
 * to a genuinely running S3-compatible service: local MinIO
 * (`docker-compose.yml`). It's the only place that actually proves the
 * presigned-URL contract, byte-transport, and public-read behaviour work
 * against a real S3-compatible server, not a simulation of one.
 *
 * **Isolated bucket, isolated data, isolated database:**
 * - `taek-shops-verify-images` — a bucket created ONLY for this
 *   verification, distinct from `taek-shops-dev-images` (real local dev
 *   data) and from whatever bucket a real deployment would use. This file
 *   never constructs a storage client pointed at the dev bucket.
 * - `taek_shops_test` (via `./helpers/db`) — the same isolated database
 *   every other integration test uses, never the dev database.
 * - Synthetic-only product/order data, cleaned up in `afterAll` by exact
 *   slug prefix — the same fixture-ownership discipline as every other
 *   integration suite in this project.
 *
 * Skips (not fails) when `S3_*` isn't configured or MinIO isn't reachable —
 * this suite requires Docker actually running `docker compose up -d minio`
 * locally, which `npm run test:integration` must not hard-depend on.
 */

const {
  S3_ENDPOINT,
  S3_REGION,
  S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY,
  S3_PUBLIC_BASE_URL,
} = process.env;
const VERIFY_BUCKET = "taek-shops-verify-images";
const minioConfigured = Boolean(S3_ENDPOINT && S3_REGION && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY);

const PRODUCT_SLUG_PREFIX = "zzz-phase9-minio-";
const SKU_PREFIX = "PF9M-";

// Real magic bytes only, not a genuinely decodable image — fine for tests
// that are rejected before real decoding runs (size-limit, SVG rejection).
const VALID_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const SVG_BYTES = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

// A genuinely decodable JPEG (real sharp/libvips) — required for any test
// that expects `finalizeProductImageUpload` to actually SUCCEED, since it
// runs real image decoding, not just magic-byte sniffing.
let REAL_JPEG: Uint8Array<ArrayBuffer>;

let rand = 0;
function uid(): string {
  rand += 1;
  return `${Date.now().toString(36)}${rand}`;
}

async function ensureManager(): Promise<{ id: string; role: UserRole }> {
  const email = "phase9-minio-manager@taek.local";
  return db.user.upsert({
    where: { email },
    update: { role: UserRole.MANAGER, status: "ACTIVE" },
    create: { email, role: UserRole.MANAGER, status: "ACTIVE", firstName: "Phase9Minio", lastName: "Manager" },
    select: { id: true, role: true },
  });
}

async function makeProduct(): Promise<{ productId: string; slug: string }> {
  const suffix = uid();
  const slug = `${PRODUCT_SLUG_PREFIX}${suffix}`;
  const product = await db.product.create({
    data: {
      name: `Phase 9 MinIO Verify ${suffix}`,
      slug,
      status: "ACTIVE",
      active: true,
      variants: { create: { sku: `${SKU_PREFIX}${suffix}`, priceCents: 1999, optionSignature: "", active: true } },
    },
    select: { id: true },
  });
  return { productId: product.id, slug };
}

async function cleanup(): Promise<void> {
  const email = "phase9-minio-manager@taek.local";
  const actor = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (actor) await db.auditLog.deleteMany({ where: { actorUserId: actor.id } });
  await db.product.deleteMany({ where: { slug: { startsWith: PRODUCT_SLUG_PREFIX } } });
  await db.user.deleteMany({ where: { email } });
}

/**
 * Idempotently ensure the isolated verify bucket exists and carries the
 * same restrictive anonymous-access policy as `docker-compose.yml`'s
 * `minio-init` applies to the real dev bucket: anonymous `s3:GetObject`
 * ONLY under `products/*` (finalized, validated images), and no
 * `s3:ListBucket` grant at all. Code-defined here (not a manual one-off
 * `mc` command) so this suite's own fixture reproduces the secure policy
 * from a fresh MinIO instance too, the same as the dev bucket does — see
 * the roadmap's Phase 9 section for the gap this closes and why.
 */
async function ensureVerifyBucketPolicy(): Promise<void> {
  const client = new S3Client({
    endpoint: S3_ENDPOINT!,
    region: S3_REGION!,
    credentials: { accessKeyId: S3_ACCESS_KEY_ID!, secretAccessKey: S3_SECRET_ACCESS_KEY! },
    forcePathStyle: true,
  });
  await client.send(new CreateBucketCommand({ Bucket: VERIFY_BUCKET })).catch((error: unknown) => {
    const code = (error as { name?: string } | undefined)?.name;
    if (code !== "BucketAlreadyOwnedByYou" && code !== "BucketAlreadyExists") throw error;
  });
  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: ["*"] },
        Action: ["s3:GetObject"],
        Resource: [`arn:aws:s3:::${VERIFY_BUCKET}/products/*`],
      },
    ],
  };
  await client.send(new PutBucketPolicyCommand({ Bucket: VERIFY_BUCKET, Policy: JSON.stringify(policy) }));
}

describe.skipIf(!minioConfigured)("real MinIO — signed upload, staging, byte validation, finalize, storefront, cleanup", () => {
  let manager: { id: string; role: UserRole };
  let storage: S3ObjectStorage;

  beforeAll(async () => {
    const jpegBytes = await sharp({
      create: { width: 20, height: 20, channels: 3, background: { r: 200, g: 50, b: 50 } },
    })
      .jpeg()
      .toBuffer();
    REAL_JPEG = Uint8Array.from(jpegBytes);
    await ensureVerifyBucketPolicy();
    await cleanup();
    manager = await ensureManager();
    storage = new S3ObjectStorage({
      endpoint: S3_ENDPOINT!,
      region: S3_REGION!,
      bucket: VERIFY_BUCKET, // isolated — never the dev bucket
      accessKeyId: S3_ACCESS_KEY_ID!,
      secretAccessKey: S3_SECRET_ACCESS_KEY!,
      publicBaseUrl: S3_PUBLIC_BASE_URL,
    });
    __setObjectStorage(storage);
  });

  afterAll(async () => {
    __setObjectStorage(undefined);
    await cleanup();
    await db.$disconnect();
  });

  it("issues a real presigned PUT URL and a real browser-style PUT actually lands the bytes in MinIO", async () => {
    const { productId } = await makeProduct();
    const slot = await createProductImageUploadSlot(
      manager,
      productId,
      { contentType: "image/jpeg", byteSize: VALID_JPEG.byteLength },
      db,
    );
    expect(slot.uploadId).not.toBeNull();
    expect(slot.signedUpload).not.toBeNull();
    expect(slot.signedUpload!.url).toContain(VERIFY_BUCKET);

    // A real HTTP PUT, exactly what a browser would do — bypassing this
    // app's server entirely, straight to MinIO.
    const putResponse = await fetch(slot.signedUpload!.url, {
      method: slot.signedUpload!.method,
      headers: slot.signedUpload!.headers,
      body: VALID_JPEG,
    });
    expect(putResponse.ok).toBe(true);

    const uploadRow = await db.productImageUpload.findUniqueOrThrow({ where: { id: slot.uploadId! } });
    expect(await storage.exists(uploadRow.storageKey)).toBe(true);
    // Staged, private in the sense that matters: nothing in the app has
    // created a ProductImage row for it yet, so it is unreachable through
    // any application query (storefront or admin).
    expect(await db.productImage.count({ where: { productId } })).toBe(0);
  });

  it("finalize rejects real bytes that are actually SVG (never trusts the claim), and deletes the staged MinIO object", async () => {
    const { productId } = await makeProduct();
    const slot = await createProductImageUploadSlot(
      manager,
      productId,
      { contentType: "image/jpeg", byteSize: SVG_BYTES.byteLength },
      db,
    );
    await fetch(slot.signedUpload!.url, {
      method: slot.signedUpload!.method,
      headers: slot.signedUpload!.headers,
      body: SVG_BYTES,
    });
    const uploadRow = await db.productImageUpload.findUniqueOrThrow({ where: { id: slot.uploadId! } });
    expect(await storage.exists(uploadRow.storageKey)).toBe(true); // really landed in MinIO

    await expect(finalizeProductImageUpload(manager, slot.uploadId!, {}, db)).rejects.toBeInstanceOf(
      CatalogValidationError,
    );

    expect(await storage.exists(uploadRow.storageKey)).toBe(false); // really deleted from MinIO
    expect(await db.productImageUpload.findUnique({ where: { id: slot.uploadId! } })).toBeNull();
    expect(await db.productImage.count({ where: { productId } })).toBe(0);
  });

  it("rejects real oversized bytes at finalize even though the claim was within range", async () => {
    const { productId } = await makeProduct();
    const big = new Uint8Array(6_000_001);
    big.set(VALID_JPEG);
    const slot = await createProductImageUploadSlot(
      manager,
      productId,
      { contentType: "image/jpeg", byteSize: 1000 }, // claim understates the real size
      db,
    );
    await fetch(slot.signedUpload!.url, {
      method: slot.signedUpload!.method,
      headers: slot.signedUpload!.headers,
      body: big,
    });
    await expect(finalizeProductImageUpload(manager, slot.uploadId!, {}, db)).rejects.toBeInstanceOf(
      CatalogValidationError,
    );
  });

  it("finalizes a genuinely valid real upload, and the image is actually fetchable at its storefront URL", async () => {
    const { productId, slug } = await makeProduct();
    const slot = await createProductImageUploadSlot(
      manager,
      productId,
      { contentType: "image/jpeg", byteSize: REAL_JPEG.byteLength },
      db,
    );
    const stagingKey = (await db.productImageUpload.findUniqueOrThrow({ where: { id: slot.uploadId! } }))
      .storageKey;

    await fetch(slot.signedUpload!.url, {
      method: slot.signedUpload!.method,
      headers: slot.signedUpload!.headers,
      body: REAL_JPEG,
    });

    const image = await finalizeProductImageUpload(manager, slot.uploadId!, { altText: "Verify" }, db);
    expect(image.isPrimary).toBe(true);
    expect(await storage.exists(stagingKey)).toBe(false); // staging cleaned up

    // Storefront access: the same resolution path a real page render uses,
    // then a REAL fetch against the REAL MinIO-served URL — not a mock.
    const publicProduct = await getPublicProductBySlug(slug);
    expect(publicProduct!.images).toHaveLength(1);
    const publicUrl = publicProduct!.images[0]!.url;
    expect(publicUrl).toContain(VERIFY_BUCKET);

    const storefrontFetch = await fetch(publicUrl);
    expect(storefrontFetch.ok).toBe(true);
    const bytesBack = new Uint8Array(await storefrontFetch.arrayBuffer());
    expect(bytesBack.slice(0, 4)).toEqual(REAL_JPEG.slice(0, 4)); // real JPEG magic bytes, round-tripped
  });

  it("cleanup sweep deletes a real abandoned staged object from MinIO and its tracking row", async () => {
    const { productId } = await makeProduct();
    const slot = await createProductImageUploadSlot(
      manager,
      productId,
      { contentType: "image/jpeg", byteSize: VALID_JPEG.byteLength },
      db,
    );
    await fetch(slot.signedUpload!.url, {
      method: slot.signedUpload!.method,
      headers: slot.signedUpload!.headers,
      body: VALID_JPEG,
    });
    const stagingKey = (await db.productImageUpload.findUniqueOrThrow({ where: { id: slot.uploadId! } }))
      .storageKey;
    expect(await storage.exists(stagingKey)).toBe(true);

    // Simulate genuine abandonment (closed tab, never finalized).
    await db.productImageUpload.update({
      where: { id: slot.uploadId! },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });

    const result = await sweepAbandonedImageUploads(db, storage);
    expect(result.found).toBeGreaterThanOrEqual(1);
    expect(await storage.exists(stagingKey)).toBe(false); // really gone from MinIO
    expect(await db.productImageUpload.findUnique({ where: { id: slot.uploadId! } })).toBeNull();
  });

  it("a fresh (not-yet-abandoned) staged object survives a sweep — retry is safe, not destructive", async () => {
    const { productId } = await makeProduct();
    const slot = await createProductImageUploadSlot(
      manager,
      productId,
      { contentType: "image/jpeg", byteSize: REAL_JPEG.byteLength },
      db,
    );
    await fetch(slot.signedUpload!.url, {
      method: slot.signedUpload!.method,
      headers: slot.signedUpload!.headers,
      body: REAL_JPEG,
    });
    const stagingKey = (await db.productImageUpload.findUniqueOrThrow({ where: { id: slot.uploadId! } }))
      .storageKey;

    await sweepAbandonedImageUploads(db, storage);
    expect(await storage.exists(stagingKey)).toBe(true); // untouched — still within the grace window

    // The upload can still be finalized normally afterward.
    const image = await finalizeProductImageUpload(manager, slot.uploadId!, {}, db);
    expect(image.id).toBeTruthy();
  });

  describe("anonymous access policy — private staging is enforced at the storage layer, not just by the app never linking to staged keys", () => {
    it("anonymous bucket listing is denied", async () => {
      const listUrl = `${S3_PUBLIC_BASE_URL}/${VERIFY_BUCKET}?list-type=2`;
      const response = await fetch(listUrl);
      expect(response.ok).toBe(false);
      expect(response.status).toBe(403);
    });

    it("anonymous GET of a known staged (unfinalized) key is denied, even though the exact key is known", async () => {
      const { productId } = await makeProduct();
      const slot = await createProductImageUploadSlot(
        manager,
        productId,
        { contentType: "image/jpeg", byteSize: REAL_JPEG.byteLength },
        db,
      );
      // A real, authorized PUT actually lands the bytes — proves this isn't
      // just "the object doesn't exist," but a genuine access denial on a
      // real, present object.
      const putResponse = await fetch(slot.signedUpload!.url, {
        method: slot.signedUpload!.method,
        headers: slot.signedUpload!.headers,
        body: REAL_JPEG,
      });
      expect(putResponse.ok).toBe(true);
      const stagingKey = (await db.productImageUpload.findUniqueOrThrow({ where: { id: slot.uploadId! } }))
        .storageKey;
      expect(await storage.exists(stagingKey)).toBe(true); // authenticated (root) access confirms it's really there

      const anonymousGet = await fetch(storage.publicUrl(stagingKey));
      expect(anonymousGet.ok).toBe(false);
      expect(anonymousGet.status).toBe(403);
    });

    it("invalid (rejected) uploads are never anonymously readable, before or after finalize rejects them", async () => {
      const { productId } = await makeProduct();
      const slot = await createProductImageUploadSlot(
        manager,
        productId,
        { contentType: "image/jpeg", byteSize: SVG_BYTES.byteLength },
        db,
      );
      await fetch(slot.signedUpload!.url, {
        method: slot.signedUpload!.method,
        headers: slot.signedUpload!.headers,
        body: SVG_BYTES, // invalid — claims JPEG, is actually SVG
      });
      const stagingKey = (await db.productImageUpload.findUniqueOrThrow({ where: { id: slot.uploadId! } }))
        .storageKey;

      // Not anonymously readable while staged and not yet validated...
      expect((await fetch(storage.publicUrl(stagingKey))).status).toBe(403);

      await expect(finalizeProductImageUpload(manager, slot.uploadId!, {}, db)).rejects.toBeInstanceOf(
        CatalogValidationError,
      );

      // ...and never promoted anywhere readable afterward either — finalize
      // deleted the staged object rather than moving it to the public
      // `products/*` prefix, so the object is simply gone, not "gone from
      // staging but now public somewhere."
      expect(await storage.exists(stagingKey)).toBe(false);
      expect((await fetch(storage.publicUrl(stagingKey))).status).toBe(403);
      expect(await db.productImage.count({ where: { productId } })).toBe(0);
    });

    it("authorized signed upload and finalized-image storefront access both still work under the restrictive policy", async () => {
      // These properties are also exercised end-to-end by the "issues a
      // real presigned PUT URL…" and "finalizes a genuinely valid real
      // upload…" tests above; this is a focused, minimal re-check scoped
      // specifically to this describe block's policy-regression concern —
      // that tightening anonymous access did not also break the
      // authenticated/legitimate paths.
      const { productId, slug } = await makeProduct();
      const slot = await createProductImageUploadSlot(
        manager,
        productId,
        { contentType: "image/jpeg", byteSize: REAL_JPEG.byteLength },
        db,
      );
      expect(slot.signedUpload).not.toBeNull(); // authorized signed upload still issued

      const putResponse = await fetch(slot.signedUpload!.url, {
        method: slot.signedUpload!.method,
        headers: slot.signedUpload!.headers,
        body: REAL_JPEG,
      });
      expect(putResponse.ok).toBe(true); // signed upload still succeeds

      const image = await finalizeProductImageUpload(manager, slot.uploadId!, {}, db);
      const publicProduct = await getPublicProductBySlug(slug);
      const publicUrl = publicProduct!.images[0]!.url;
      expect(publicUrl).toBe(storage.publicUrl(image.url.replace("storage:", "")));

      const anonymousFetch = await fetch(publicUrl); // finalized image still anonymously reachable
      expect(anonymousFetch.ok).toBe(true);
    });
  });
});
