// @vitest-environment node
import { Prisma, UserRole } from "@prisma/client";
import sharp from "sharp";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ForbiddenError, UnauthenticatedError } from "@/server/auth/errors";
import { CatalogValidationError, NotFoundError } from "@/server/catalog/errors";
import {
  createProductImageUploadSlot,
  finalizeProductImageUpload,
  reorderProductImages,
} from "@/server/catalog/image-service";
import { __setObjectStorage } from "@/server/storage";
import type { ObjectStorage } from "@/server/storage/object-storage";
import { createMockPrisma, looseMock, type MockPrisma } from "./helpers/mock-prisma";

const manager = { id: "mgr", role: UserRole.MANAGER };
const staff = { id: "stf", role: UserRole.STAFF };

// Real JPEG magic bytes only — enough for `sniffImageFormat` to accept it,
// but NOT a genuinely decodable image. Only usable in tests that are
// rejected before real decoding runs (e.g. the size-limit check, which
// happens first) — see `REAL_JPEG` below for tests that must survive
// `decodeImageDimensions`.
const VALID_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const SVG_BYTES = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

// A genuinely decodable JPEG — `finalizeProductImageUpload` runs the real
// `decodeImageDimensions` (real sharp/libvips), so any test exercising the
// success path needs bytes that actually decode, not just the right magic
// number.
let REAL_JPEG: Uint8Array;
beforeAll(async () => {
  REAL_JPEG = await sharp({
    create: { width: 20, height: 20, channels: 3, background: { r: 200, g: 50, b: 50 } },
  })
    .jpeg()
    .toBuffer();
});

function fakeStorage(overrides: Partial<ObjectStorage> = {}): ObjectStorage {
  return {
    name: "fake",
    put: vi.fn().mockResolvedValue({ key: "products/p1/final.jpg" }),
    delete: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(true),
    get: vi.fn().mockResolvedValue({ body: VALID_JPEG, contentType: "image/jpeg" }),
    publicUrl: vi.fn().mockReturnValue("http://localhost/fake"),
    createSignedUpload: vi
      .fn()
      .mockResolvedValue({ url: "http://minio.local/put", method: "PUT" as const, key: "staging/p1/x" }),
    ...overrides,
  };
}

describe("createProductImageUploadSlot", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
    looseMock(db.product.findUnique).mockImplementation(() => Promise.resolve({ id: "p1" } as never));
  });

  it("denies unauthenticated and STAFF; allows MANAGER", async () => {
    __setObjectStorage(fakeStorage());
    const input = { contentType: "image/jpeg", byteSize: 1000 };
    await expect(createProductImageUploadSlot(null, "p1", input, db)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    await expect(createProductImageUploadSlot(staff, "p1", input, db)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    looseMock(db.productImageUpload.create).mockImplementation(() =>
      Promise.resolve({ id: "up1" } as never),
    );
    await expect(createProductImageUploadSlot(manager, "p1", input, db)).resolves.toBeDefined();
  });

  it("rejects a disallowed content-type claim before ever contacting storage", async () => {
    const storage = fakeStorage();
    __setObjectStorage(storage);
    await expect(
      createProductImageUploadSlot(manager, "p1", { contentType: "image/svg+xml", byteSize: 100 }, db),
    ).rejects.toBeInstanceOf(CatalogValidationError);
    expect(storage.createSignedUpload).not.toHaveBeenCalled();
  });

  it("rejects an oversized claimed byte size", async () => {
    __setObjectStorage(fakeStorage());
    await expect(
      createProductImageUploadSlot(
        manager,
        "p1",
        { contentType: "image/jpeg", byteSize: 6_000_000 },
        db,
      ),
    ).rejects.toBeInstanceOf(CatalogValidationError);
  });

  it("rejects a variantId that does not belong to the product", async () => {
    __setObjectStorage(fakeStorage());
    looseMock(db.productVariant.findFirst).mockImplementation(() => Promise.resolve(null));
    await expect(
      createProductImageUploadSlot(
        manager,
        "p1",
        { contentType: "image/jpeg", byteSize: 100, variantId: "other-product-variant" },
        db,
      ),
    ).rejects.toBeInstanceOf(CatalogValidationError);
  });

  it("returns a signed upload and creates a tracking row when the backend supports direct upload", async () => {
    __setObjectStorage(fakeStorage());
    looseMock(db.productImageUpload.create).mockImplementation(() =>
      Promise.resolve({ id: "up1" } as never),
    );
    const result = await createProductImageUploadSlot(
      manager,
      "p1",
      { contentType: "image/jpeg", byteSize: 1000 },
      db,
    );
    expect(result.uploadId).toBe("up1");
    expect(result.signedUpload).not.toBeNull();
    expect(db.productImageUpload.create).toHaveBeenCalledTimes(1);
  });

  it("returns null uploadId/signedUpload and creates NO tracking row when the backend has no direct upload", async () => {
    __setObjectStorage(fakeStorage({ createSignedUpload: vi.fn().mockResolvedValue(null) }));
    const result = await createProductImageUploadSlot(
      manager,
      "p1",
      { contentType: "image/jpeg", byteSize: 1000 },
      db,
    );
    expect(result.uploadId).toBeNull();
    expect(result.signedUpload).toBeNull();
    expect(db.productImageUpload.create).not.toHaveBeenCalled();
  });
});

describe("finalizeProductImageUpload", () => {
  let db: MockPrisma;
  const uploadRow = {
    id: "up1",
    productId: "p1",
    variantId: null,
    storageKey: "staging/p1/x",
    claimedContentType: "image/jpeg",
    claimedAt: null as Date | null,
    finalKey: null as string | null,
    attempts: 0,
    maxAttempts: 5,
  };

  beforeEach(() => {
    db = createMockPrisma();
    // `finalizeProductImageUpload` claims the row atomically via a
    // conditional UPDATE (`claimedAt: null` -> now), never a delete — the
    // row deliberately survives the claim as its own durable recovery
    // record. The same `update` mock also serves the later `finalKey`
    // write, merging each call's `data` into the row so the function's
    // subsequent reads of `upload.*` stay consistent.
    looseMock(db.productImageUpload.update).mockImplementation((arg) =>
      Promise.resolve({ ...uploadRow, ...arg.data } as never),
    );
    looseMock(db.productImageUpload.delete).mockImplementation(() => Promise.resolve(uploadRow as never));
    looseMock(db.product.findUnique).mockImplementation(() => Promise.resolve({ id: "p1" } as never));
    looseMock(db.productImage.count).mockImplementation(() => Promise.resolve(0));
    looseMock(db.productImage.create).mockImplementation(() =>
      Promise.resolve({ id: "img1", url: "storage:x" } as never),
    );
  });

  it("404s for an unknown upload id (never accepts an arbitrary/unowned key)", async () => {
    // The atomic claim (a conditional `db.productImageUpload.update`) is
    // what reports "not found" — Prisma throws P2025 when no row matches
    // the `where` (also covers "already claimed by another call").
    looseMock(db.productImageUpload.update).mockImplementation(() => {
      throw new Prisma.PrismaClientKnownRequestError("No record found", {
        code: "P2025",
        clientVersion: "test",
      });
    });
    __setObjectStorage(fakeStorage());
    await expect(finalizeProductImageUpload(manager, "nope", {}, db)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("rejects and cleans up when the staged object never actually landed in storage", async () => {
    const storage = fakeStorage({ get: vi.fn().mockResolvedValue(null) });
    __setObjectStorage(storage);
    await expect(finalizeProductImageUpload(manager, "up1", {}, db)).rejects.toBeInstanceOf(
      CatalogValidationError,
    );
    expect(db.productImageUpload.delete).toHaveBeenCalledWith({ where: { id: "up1" } });
  });

  it("rejects and cleans up bytes that don't actually match a supported image format (SVG)", async () => {
    const storage = fakeStorage({
      get: vi.fn().mockResolvedValue({ body: SVG_BYTES, contentType: "image/svg+xml" }),
    });
    __setObjectStorage(storage);
    await expect(finalizeProductImageUpload(manager, "up1", {}, db)).rejects.toBeInstanceOf(
      CatalogValidationError,
    );
    expect(storage.delete).toHaveBeenCalledWith("staging/p1/x");
    expect(db.productImageUpload.delete).toHaveBeenCalledWith({ where: { id: "up1" } });
    expect(db.productImage.create).not.toHaveBeenCalled();
  });

  it("rejects oversized actual bytes even if the original claim was within range", async () => {
    const big = new Uint8Array(6_000_001);
    big.set(VALID_JPEG); // real JPEG header, but the size itself is what's rejected
    __setObjectStorage(
      fakeStorage({ get: vi.fn().mockResolvedValue({ body: big, contentType: "image/jpeg" }) }),
    );
    await expect(finalizeProductImageUpload(manager, "up1", {}, db)).rejects.toBeInstanceOf(
      CatalogValidationError,
    );
  });

  it("finalizes a genuinely valid image: claims durably, records finalKey, moves to a final key, attaches it, and only then removes the tracking row", async () => {
    const storage = fakeStorage({
      get: vi.fn().mockResolvedValue({ body: REAL_JPEG, contentType: "image/jpeg" }),
    });
    __setObjectStorage(storage);
    const image = await finalizeProductImageUpload(manager, "up1", { altText: "A dobok" }, db);
    expect(image.id).toBe("img1");
    expect(storage.put).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith("staging/p1/x");

    // The claim is a conditional UPDATE, not a delete — the row survives
    // it as the durable recovery record for the rest of this call.
    expect(db.productImageUpload.update).toHaveBeenCalledWith({
      where: { id: "up1", claimedAt: null },
      data: { claimedAt: expect.any(Date) },
    });
    // `finalKey` is durably recorded before the final object is written —
    // the crash-recovery hinge `sweepAbandonedImageUploads` relies on.
    expect(db.productImageUpload.update).toHaveBeenCalledWith({
      where: { id: "up1" },
      data: { finalKey: expect.stringContaining("products/p1/") },
    });
    // Only removed once the ProductImage row durably exists (inside the
    // same transaction as the row deletion — see the module comment).
    expect(db.productImageUpload.delete).toHaveBeenCalledWith({ where: { id: "up1" } });
  });
});

describe("reorderProductImages", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
  });

  it("rejects a reorder list that doesn't exactly match the product's current images", async () => {
    looseMock(db.productImage.findMany).mockImplementation(() =>
      Promise.resolve([{ id: "a" }, { id: "b" }] as never),
    );
    await expect(reorderProductImages(manager, "p1", ["a", "c"], {}, db)).rejects.toBeInstanceOf(
      CatalogValidationError,
    );
    await expect(
      reorderProductImages(manager, "p1", ["a"], {}, db), // missing "b"
    ).rejects.toBeInstanceOf(CatalogValidationError);
  });

  it("applies the new positions when the list exactly matches", async () => {
    looseMock(db.productImage.findMany).mockImplementation(() =>
      Promise.resolve([{ id: "a" }, { id: "b" }] as never),
    );
    await reorderProductImages(manager, "p1", ["b", "a"], {}, db);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.productImage.update).toHaveBeenCalledWith({ where: { id: "b" }, data: { position: 0 } });
    expect(db.productImage.update).toHaveBeenCalledWith({ where: { id: "a" }, data: { position: 1 } });
  });
});
