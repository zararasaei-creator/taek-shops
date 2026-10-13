import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import {
  isAllowedImageType,
  type ObjectStorage,
  type PutObjectInput,
  type SignedUpload,
} from "./object-storage.ts";

/**
 * S3-compatible object storage (Phase 9) — works against real S3 or any
 * S3-compatible service, including local MinIO (`docker-compose.yml`).
 * `forcePathStyle` is required for MinIO (it doesn't do virtual-hosted-style
 * bucket addressing by default the way AWS S3 does).
 *
 * Relative imports only (no `@/` alias) — this module is also constructed
 * directly by `scripts/cleanup-image-uploads.ts`, a plain `node
 * scripts/cleanup-image-uploads.ts` CLI script outside Next's/Vitest's
 * bundler-aware resolution. Same constraint as
 * `src/server/notifications/email-outbox.ts` — see that file's module
 * comment for the full explanation and the empirical proof.
 */

export interface S3ObjectStorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * The URL browsers should use to reach this storage (may differ from
   * `endpoint`, e.g. behind a reverse proxy or in a container network). For
   * local MinIO in dev this is normally the same as `endpoint`. Local MinIO
   * URLs are a development convenience only — NOT a production CDN; see
   * `docs/architecture.md` / the roadmap for that explicit distinction.
   */
  publicBaseUrl?: string;
  /** Presigned upload URL lifetime. Default: 5 minutes. */
  signedUploadExpirySeconds?: number;
}

export class S3ObjectStorage implements ObjectStorage {
  readonly name = "s3";
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl: string;
  private readonly signedUploadExpirySeconds: number;

  constructor(config: S3ObjectStorageConfig) {
    this.bucket = config.bucket;
    this.publicBaseUrl = (config.publicBaseUrl ?? config.endpoint).replace(/\/$/, "");
    this.signedUploadExpirySeconds = config.signedUploadExpirySeconds ?? 300;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: true,
    });
  }

  async put(input: PutObjectInput): Promise<{ key: string }> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
      }),
    );
    return { key: input.key };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      if (isNotFoundError(error)) return false;
      throw error;
    }
  }

  async get(key: string): Promise<{ body: Uint8Array; contentType: string } | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!result.Body) return null;
      const body = await result.Body.transformToByteArray();
      return { body, contentType: result.ContentType ?? "application/octet-stream" };
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  publicUrl(key: string): string {
    return `${this.publicBaseUrl}/${this.bucket}/${key}`;
  }

  async createSignedUpload(key: string, contentType: string): Promise<SignedUpload | null> {
    // Never generate a signed upload for a type we wouldn't accept anyway —
    // the real, authoritative check is still the byte-sniff at finalize
    // time (a claimed content-type is never trusted), but there's no reason
    // to hand out a presigned URL for an obviously-disallowed claim either.
    if (!isAllowedImageType(contentType)) return null;
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: this.signedUploadExpirySeconds,
    });
    return { url, method: "PUT", headers: { "Content-Type": contentType }, key };
  }
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = "name" in error ? String((error as { name?: unknown }).name) : "";
  const httpStatus =
    "$metadata" in error
      ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      : undefined;
  return name === "NotFound" || name === "NoSuchKey" || httpStatus === 404;
}
