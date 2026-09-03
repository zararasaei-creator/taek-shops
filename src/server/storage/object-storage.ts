/**
 * Object-storage abstraction for product images (and later, other assets).
 *
 * Nothing in the catalogue talks to a concrete provider — services depend on
 * this interface. Phase 4 ships a local-filesystem implementation for
 * development/tests; an S3-compatible implementation is wired in when the
 * `S3_*` environment variables are configured (see `docs/architecture.md`
 * § "Image-storage approach").
 *
 * Binary image data is never stored in PostgreSQL — only a reference.
 */

export interface PutObjectInput {
  key: string;
  body: Uint8Array;
  contentType: string;
}

export interface SignedUpload {
  url: string;
  method: "PUT" | "POST";
  headers?: Record<string, string>;
  /** The storage key the uploaded object will have. */
  key: string;
}

export interface ObjectStorage {
  readonly name: string;
  /** Store bytes at `key`. Returns the canonical key. */
  put(input: PutObjectInput): Promise<{ key: string }>;
  /** Remove the object. Missing keys are not an error. */
  delete(key: string): Promise<void>;
  /** Whether an object exists. */
  exists(key: string): Promise<boolean>;
  /** Fetch bytes (used by the dev media route). May be unsupported by CDN-only backends. */
  get(key: string): Promise<{ body: Uint8Array; contentType: string } | null>;
  /** Publicly reachable URL for `key`. */
  publicUrl(key: string): string;
  /**
   * A short-lived URL the browser can upload directly to, bypassing the app
   * server. Optional — backends without direct upload return `null` and the app
   * proxies the upload instead.
   */
  createSignedUpload(key: string, contentType: string): Promise<SignedUpload | null>;
}

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
]);

export function isAllowedImageType(contentType: string): boolean {
  return ALLOWED_IMAGE_TYPES.has(contentType.toLowerCase());
}

/** Build a safe, collision-resistant storage key for a product image. */
export function productImageKey(productId: string, filename: string): string {
  const ext = (filename.match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? "bin").toLowerCase();
  const random = Math.random().toString(36).slice(2, 10);
  return `products/${productId}/${Date.now()}-${random}.${ext}`;
}

/** Reject keys that could escape the storage root. */
export function isSafeStorageKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= 512 &&
    !key.startsWith("/") &&
    !key.includes("..") &&
    !key.includes("\\") &&
    /^[A-Za-z0-9/_.-]+$/.test(key)
  );
}
