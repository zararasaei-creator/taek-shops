/**
 * Abandoned/crashed product-image-upload cleanup (Phase 9).
 *
 * Two distinct things get recovered here, both driven by the same
 * `ProductImageUpload` row:
 *
 * 1. **Never-finalized uploads**: a row exists between "signed upload slot
 *    created" and "finalized" (see `image-service.ts`'s
 *    `createProductImageUploadSlot` / `finalizeProductImageUpload`). A row
 *    whose `createdAt` outlives `maxAgeMs` and was never even claimed
 *    (`claimedAt` still null) was genuinely abandoned: a closed tab, a
 *    crashed browser, a network failure between "uploaded to storage" and
 *    "told the app to finalize it."
 * 2. **Crashed/stuck finalize attempts**: `finalizeProductImageUpload`
 *    claims a row (sets `claimedAt`) and — critically — does NOT delete it
 *    until finalize reaches a genuine terminal state (rejected-and-cleaned,
 *    or succeeded-with-`ProductImage`-created). If the process crashes
 *    after claiming and before that, the row survives with `claimedAt` set,
 *    which is exactly what makes it recoverable here — a row still claimed
 *    after `stuckClaimMaxAgeMs` (a normal finalize completes in well under
 *    a second, so this is a generous bound, not a tight one) is treated as
 *    crashed, not "still working."
 *
 * For a crashed/stuck claim, `finalKey` (set just before the validated
 * bytes are written to their final storage key, before the row it was
 * written to) tells recovery exactly how far the crashed attempt got:
 * - `finalKey` unset → the crash was before or during validation; only the
 *   staging object needs cleanup.
 * - `finalKey` set, but no `ProductImage` references it → the crash was
 *   between writing the final object and committing the `ProductImage`
 *   row (or the transaction rolled back); both the final object and the
 *   staging object are unreferenced and safe to delete — the upload can
 *   simply be redone.
 * - `finalKey` set AND a `ProductImage` already references it → finalize
 *   actually succeeded; only the tracking row (and a possibly-stale
 *   staging duplicate) are cleaned up — **the final image itself is never
 *   touched**. This is what makes recovery safe to run automatically: it
 *   can never delete a live, attached image, because it always checks
 *   which case it's in before deleting anything at `finalKey`.
 *
 * Run via `npm run images:cleanup-uploads` (`scripts/cleanup-image-uploads.ts`).
 *
 * **Genuine bounded retry, not just a best-effort single pass**: a storage
 * delete can fail (a transient network blip, a permissions change). If it
 * does, the row's `attempts` is incremented and the row is KEPT — a later
 * sweep run gets another chance at deleting the same object(s), using the
 * same tracking row, rather than the failure being logged once and the only
 * record of that orphaned object silently discarded. Only once `attempts`
 * reaches `maxAttempts` does the sweep give up and remove the row anyway
 * (logged clearly as a give-up, not a success), so a permanently
 * undeletable object can't wedge this table open forever — bounded, per
 * the original requirement.
 *
 * Only relative imports here (no `@/` alias) — see `email-outbox.ts`'s
 * module comment in `src/server/notifications/` for the full explanation;
 * same constraint, same reason (this module is also constructed by a plain
 * `node` CLI script). `db` and `storage` are required parameters for the
 * same reason `email-outbox.ts`'s functions are: this runs both inside the
 * app (a shared singleton available) and standalone (its own instances).
 */

import type { PrismaClient } from "@prisma/client";

import type { ObjectStorage } from "./object-storage.ts";
import { errorFields, logError } from "../observability/logger.ts";

type Db = Pick<PrismaClient, "productImageUpload" | "productImage">;

// Matches `image-service.ts`'s own `STORAGE_PREFIX` — duplicated, not
// imported, because that module (and everything it pulls in) uses `@/`
// bundler-alias imports that plain `node scripts/*.ts` cannot resolve; see
// the module comment above for the full constraint.
const STORAGE_URL_PREFIX = "storage:";

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours — never-claimed rows
const DEFAULT_STUCK_CLAIM_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutes — claimed rows

export interface SweepResult {
  found: number;
  storageDeleted: number;
  /** Deletion failed this pass but the row survives for a later retry. */
  retriesScheduled: number;
  /** Deletion failed and `maxAttempts` was reached — the row was removed anyway. */
  gaveUp: number;
  /** A crashed/stuck finalize claim was found and cleanly recovered. */
  recoveredClaims: number;
}

export async function sweepAbandonedImageUploads(
  db: Db,
  storage: ObjectStorage,
  opts: { maxAgeMs?: number; stuckClaimMaxAgeMs?: number } = {},
): Promise<SweepResult> {
  const cutoff = new Date(Date.now() - (opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS));
  const claimCutoff = new Date(Date.now() - (opts.stuckClaimMaxAgeMs ?? DEFAULT_STUCK_CLAIM_MAX_AGE_MS));
  const stale = await db.productImageUpload.findMany({
    where: {
      OR: [{ claimedAt: null, createdAt: { lt: cutoff } }, { claimedAt: { lt: claimCutoff } }],
    },
    select: {
      id: true,
      storageKey: true,
      finalKey: true,
      claimedAt: true,
      attempts: true,
      maxAttempts: true,
    },
  });

  let storageDeleted = 0;
  let retriesScheduled = 0;
  let gaveUp = 0;
  let recoveredClaims = 0;

  for (const upload of stale) {
    try {
      // A `finalKey` that's already attached to a real `ProductImage` means
      // finalize actually succeeded — never delete that object, only the
      // stale tracking row (and a possibly-superseded staging duplicate).
      const finalImageAttached = upload.finalKey
        ? (await db.productImage.count({ where: { url: `${STORAGE_URL_PREFIX}${upload.finalKey}` } })) > 0
        : false;

      await storage.delete(upload.storageKey);
      if (upload.finalKey && !finalImageAttached) {
        await storage.delete(upload.finalKey);
      }
      storageDeleted += 1;
      await db.productImageUpload.delete({ where: { id: upload.id } });
      if (upload.claimedAt) recoveredClaims += 1;
    } catch (error) {
      const attempts = upload.attempts + 1;
      if (attempts >= upload.maxAttempts) {
        gaveUp += 1;
        logError("image_cleanup.upload_gave_up", {
          uploadId: upload.id,
          attempts,
          storageKey: upload.storageKey, // internal object key — needed to find the leftover object
          finalKey: upload.finalKey ?? null,
          ...errorFields(error),
        });
        await db.productImageUpload.delete({ where: { id: upload.id } });
      } else {
        retriesScheduled += 1;
        logError("image_cleanup.upload_retry_scheduled", {
          uploadId: upload.id,
          attempts,
          maxAttempts: upload.maxAttempts,
          ...errorFields(error),
        });
        await db.productImageUpload.update({ where: { id: upload.id }, data: { attempts } });
      }
    }
  }

  return { found: stale.length, storageDeleted, retriesScheduled, gaveUp, recoveredClaims };
}
