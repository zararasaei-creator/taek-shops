import { serverEnv } from "@/server/config/env";
import { LocalObjectStorage } from "@/server/storage/local-object-storage";
import type { ObjectStorage } from "@/server/storage/object-storage";

/**
 * Storage backend selection. Returns the S3-compatible backend when `S3_*` is
 * fully configured; otherwise the local-filesystem backend. The S3 backend
 * itself is a later phase — this factory is the single switch point.
 */

let cached: ObjectStorage | undefined;

function s3Configured(): boolean {
  return Boolean(
    serverEnv.S3_ENDPOINT &&
    serverEnv.S3_REGION &&
    serverEnv.S3_BUCKET &&
    serverEnv.S3_ACCESS_KEY_ID &&
    serverEnv.S3_SECRET_ACCESS_KEY,
  );
}

export function getObjectStorage(): ObjectStorage {
  if (cached) return cached;
  if (s3Configured()) {
    // TODO(phase-image-upload): construct S3ObjectStorage from serverEnv.S3_*.
    // Falling back to local until that backend lands avoids a hard failure.
    console.warn(
      "[storage] S3_* is configured but the S3 backend is not implemented yet; using local storage.",
    );
  }
  cached = new LocalObjectStorage();
  return cached;
}

/** Test hook. */
export function __setObjectStorage(storage: ObjectStorage | undefined): void {
  cached = storage;
}

export * from "@/server/storage/object-storage";
