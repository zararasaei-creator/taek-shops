/**
 * Abandoned product-image-upload cleanup (Phase 9).
 *
 * Sweeps `ProductImageUpload` rows older than the bounded age threshold
 * (default 24h — see `src/server/storage/upload-cleanup.ts`) and deletes
 * both the staged storage object and the tracking row. A row only exists
 * between "signed upload slot created" and "finalized," so anything this
 * old was genuinely abandoned (closed tab, crashed browser, network
 * failure), never a real, live image.
 *
 * Only the S3-compatible backend (real S3 or local MinIO) ever creates
 * these rows — `createProductImageUploadSlot` only stages a row when
 * `storage.createSignedUpload()` returns a real signed upload; the local
 * filesystem backend (`LocalObjectStorage`, which has no direct-upload
 * endpoint) instead validates and stores an upload in one synchronous
 * step with no staging row at all. So when `S3_*` isn't configured, there
 * is nothing for this sweep to do, by construction, not by an unhandled
 * gap — this script reports that and exits cleanly rather than needing a
 * local-backend branch.
 *
 * Run with:  npm run images:cleanup-uploads
 *
 * Cannot use the `@/` path alias — this runs as a plain `node
 * scripts/cleanup-image-uploads.ts`, outside Next's/Vitest's bundler-aware
 * resolution, so only relative imports (with explicit `.ts` extensions)
 * reach the storage module. Same constraint as `scripts/dispatch-emails.ts`
 * — see that file's comment for the full explanation.
 */

import { PrismaClient } from "@prisma/client";

import { S3ObjectStorage } from "../src/server/storage/s3-object-storage.ts";
import { sweepAbandonedImageUploads } from "../src/server/storage/upload-cleanup.ts";
import { startJobRun } from "../src/server/observability/logger.ts";

const prisma = new PrismaClient();
// Structured events: job.started, then job.completed | job.failed (job/runId/durationMs). See docs/monitoring.md.
const run = startJobRun("images:cleanup-uploads");

async function main(): Promise<void> {
  const { S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_PUBLIC_BASE_URL } =
    process.env;
  if (!S3_ENDPOINT || !S3_REGION || !S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
    // Not an error for the local-filesystem backend; in production it means S3 is not configured.
    run.finish("skipped", { reason: "s3_not_configured" });
    return;
  }

  const storage = new S3ObjectStorage({
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    bucket: S3_BUCKET,
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
    publicBaseUrl: S3_PUBLIC_BASE_URL,
  });

  const { found, storageDeleted, retriesScheduled, gaveUp, recoveredClaims } =
    await sweepAbandonedImageUploads(prisma, storage);
  // gaveUp > 0 means storage object(s) may remain (details were logged per upload above).
  run.finish(gaveUp > 0 ? "attention_required" : "ok", { found, storageDeleted, retriesScheduled, gaveUp, recoveredClaims });
}

main()
  .catch((error) => {
    run.fail(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
