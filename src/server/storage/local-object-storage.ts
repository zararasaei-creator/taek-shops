import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { clientEnv } from "@/server/config/env";
import {
  isSafeStorageKey,
  type ObjectStorage,
  type PutObjectInput,
  type SignedUpload,
} from "@/server/storage/object-storage";

/**
 * Development / test object storage backed by the local filesystem under
 * `./storage/objects` (git-ignored). Objects are served by the
 * `GET /api/media/[...key]` route. NOT for production — swap in an S3-compatible
 * implementation there.
 */
export class LocalObjectStorage implements ObjectStorage {
  readonly name = "local";
  private readonly root: string;

  constructor(root = path.join(process.cwd(), "storage", "objects")) {
    this.root = root;
  }

  private resolve(key: string): string {
    if (!isSafeStorageKey(key)) throw new Error(`Unsafe storage key: ${key}`);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) {
      throw new Error(`Storage key escapes root: ${key}`);
    }
    return full;
  }

  async put(input: PutObjectInput): Promise<{ key: string }> {
    const full = this.resolve(input.key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, input.body);
    await writeFile(`${full}.meta`, JSON.stringify({ contentType: input.contentType }));
    return { key: input.key };
  }

  async delete(key: string): Promise<void> {
    const full = this.resolve(key);
    await rm(full, { force: true });
    await rm(`${full}.meta`, { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async get(key: string): Promise<{ body: Uint8Array; contentType: string } | null> {
    try {
      const full = this.resolve(key);
      const body = await readFile(full);
      let contentType = "application/octet-stream";
      try {
        const meta = JSON.parse(await readFile(`${full}.meta`, "utf8")) as { contentType?: string };
        if (meta.contentType) contentType = meta.contentType;
      } catch {
        /* no meta sidecar */
      }
      return { body: new Uint8Array(body), contentType };
    } catch {
      return null;
    }
  }

  publicUrl(key: string): string {
    return `${clientEnv.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/api/media/${key}`;
  }

  async createSignedUpload(): Promise<SignedUpload | null> {
    // The local backend has no direct-upload endpoint; the app proxies uploads.
    return null;
  }
}

export function hashBytes(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}
