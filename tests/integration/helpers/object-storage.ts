import type { ObjectStorage, PutObjectInput, SignedUpload } from "@/server/storage/object-storage";

/**
 * An in-memory `ObjectStorage` for integration tests — proves the
 * application's own upload/finalize/cleanup/deletion logic without a real
 * MinIO dependency for the whole integration suite (the e2e suite exercises
 * the real S3-compatible backend against real MinIO — see
 * `tests/e2e/product-images.spec.ts`). Scriptable: `createSignedUpload` can
 * be forced to return `null` to exercise the local-backend fallback path,
 * or to return a fake presigned URL to exercise the staged-upload path.
 */
export class FakeObjectStorage implements ObjectStorage {
  readonly name = "fake";
  private readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();
  readonly deletedKeys: string[] = [];
  supportsDirectUpload = true;
  private failNextDelete = false;

  async put(input: PutObjectInput): Promise<{ key: string }> {
    this.objects.set(input.key, { body: input.body, contentType: input.contentType });
    return { key: input.key };
  }

  async delete(key: string): Promise<void> {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error("simulated storage delete failure");
    }
    this.objects.delete(key);
    this.deletedKeys.push(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async get(key: string): Promise<{ body: Uint8Array; contentType: string } | null> {
    return this.objects.get(key) ?? null;
  }

  publicUrl(key: string): string {
    return `http://fake-storage.local/${key}`;
  }

  async createSignedUpload(key: string, _contentType: string): Promise<SignedUpload | null> {
    if (!this.supportsDirectUpload) return null;
    return { url: `http://fake-storage.local/presigned/${key}`, method: "PUT", key };
  }

  /** Directly stage bytes at `key`, simulating a completed direct browser upload. */
  seedStagedObject(key: string, body: Uint8Array, contentType = "image/jpeg"): void {
    this.objects.set(key, { body, contentType });
  }

  /** The next `delete()` call throws — for testing cleanup failure tolerance. */
  scriptDeleteFailure(): void {
    this.failNextDelete = true;
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }
}
