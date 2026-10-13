import { serverEnv } from "@/server/config/env";
import { LocalObjectStorage } from "@/server/storage/local-object-storage";
import { S3ObjectStorage } from "@/server/storage/s3-object-storage";
import type { ObjectStorage } from "@/server/storage/object-storage";

/**
 * Storage backend selection. Returns the S3-compatible backend (real S3 or
 * local MinIO — see `docker-compose.yml`) when `S3_*` is fully configured;
 * otherwise the local-filesystem backend used by dev/tests without Docker.
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
    cached = new S3ObjectStorage({
      endpoint: serverEnv.S3_ENDPOINT!,
      region: serverEnv.S3_REGION!,
      bucket: serverEnv.S3_BUCKET!,
      accessKeyId: serverEnv.S3_ACCESS_KEY_ID!,
      secretAccessKey: serverEnv.S3_SECRET_ACCESS_KEY!,
      publicBaseUrl: serverEnv.S3_PUBLIC_BASE_URL,
    });
    return cached;
  }
  cached = new LocalObjectStorage();
  return cached;
}

/** Test hook. */
export function __setObjectStorage(storage: ObjectStorage | undefined): void {
  cached = storage;
}

export * from "@/server/storage/object-storage";
