/**
 * Abandoned-checkout reservation recovery sweep (launch-prep milestone).
 *
 * Run with:  npm run orders:expire-abandoned
 *
 * **Not scheduled anywhere yet — an explicit pending activation step.**
 * Like `emails:dispatch` and `images:cleanup-uploads`, this is meant to run
 * on an external schedule (cron, a platform's scheduled-function feature,
 * etc.) in a real deployment; nothing in this codebase invokes it
 * automatically, and no public HTTP endpoint triggers it. Running it
 * manually, repeatedly, is always safe — see `src/server/orders/order-expiry.ts`'s
 * own module comment for exactly what it will and will not touch on a given
 * run.
 *
 * **Unlike `scripts/dispatch-emails.ts` and `scripts/cleanup-image-uploads.ts`,
 * this one is run with `tsx`, not plain `node`.** Those two scripts' target
 * modules (`src/server/notifications/*`, `src/server/storage/*`) were
 * purpose-built as a small, standalone, relative-import-only tree
 * specifically so a plain `node <file>.ts` (Node's own built-in TypeScript
 * stripping, no bundler) could reach them. The order/payment domain this
 * script needs (`order-expiry.ts`, and everything it calls —
 * `order-inventory.ts`, `payment-service.ts`, the `PaymentGateway`
 * abstraction, audit/db/env config) is deeply, pervasively woven through
 * the rest of the application via the `@/` path alias, which only a
 * bundler-aware resolver understands. Converting that whole tree to
 * relative-only imports to match the other two scripts' approach would be a
 * large, invasive change to core, already-tested payment/order logic for a
 * purely mechanical reason — out of scope for a bounded launch-prep pass.
 * `tsx` (added as a dev dependency for this) resolves `tsconfig.json`'s
 * `paths` the same way Next's/Vitest's own tooling already does, so
 * `order-expiry.ts` could be written as ordinary application code, reusing
 * the existing `PaymentGateway`/`finalizeFromPaymentIntent`/
 * `applyOrderStatusTransitionTx` machinery directly rather than
 * reimplementing any of it.
 */

import { runOrderExpirySweep } from "@/server/orders/order-expiry";
import { prisma } from "@/server/db/client";
import { logError, logWarn, startJobRun } from "@/server/observability/logger";

// Structured events (JSON lines): job.started, per-category warnings, then job.completed |
// job.failed (job/runId/durationMs). Exit codes are unchanged: non-zero when an order errored,
// when PAYMENT_CLAIMS_ACTIVE_SINCE is unset and orders were preserved because of it, or on a
// crash. Order ids only — never customer data, never raw error text. See docs/monitoring.md.
const run = startJobRun("orders:expire-abandoned");

const idsOf = (items: { orderId: string }[]) => items.slice(0, 50).map((i) => i.orderId).join(",");

async function main(): Promise<void> {
  const result = await runOrderExpirySweep(prisma);

  const byOutcome: Record<string, number> = {};
  for (const item of result.items) byOutcome[item.outcome] = (byOutcome[item.outcome] ?? 0) + 1;

  const needsReview = result.items.filter((item) => item.outcome === "preserved_claim_needs_review");
  if (needsReview.length > 0) {
    // Stock stays reserved; manual recovery required (roadmap runbook).
    logWarn("orders_expire.claim_needs_review", { runId: run.runId, count: needsReview.length, orderIds: idsOf(needsReview) });
  }

  const unconfigured = result.items.filter((item) => item.outcome === "preserved_claims_cutoff_unconfigured");
  if (unconfigured.length > 0) {
    // PAYMENT_CLAIMS_ACTIVE_SINCE is not set: fail closed (stock stays reserved) and exit non-zero.
    logError("orders_expire.configuration_required", {
      runId: run.runId,
      setting: "PAYMENT_CLAIMS_ACTIVE_SINCE",
      count: unconfigured.length,
      orderIds: idsOf(unconfigured),
    });
    process.exitCode = 1;
  }

  const legacy = result.items.filter((item) => item.outcome === "preserved_legacy_needs_review");
  if (legacy.length > 0) {
    logWarn("orders_expire.legacy_needs_review", { runId: run.runId, count: legacy.length, orderIds: idsOf(legacy) });
  }

  const errors = result.items.filter((item) => item.outcome === "error");
  if (errors.length > 0) {
    // Untouched, retried next run. The per-order error text is deliberately not logged.
    logError("orders_expire.items_failed", { runId: run.runId, count: errors.length, orderIds: idsOf(errors) });
    process.exitCode = 1;
  }

  const attention = needsReview.length > 0 || legacy.length > 0;
  run.finish(errors.length > 0 || unconfigured.length > 0 ? "completed_with_errors" : attention ? "attention_required" : "ok", {
    scanned: result.scanned,
    outcomes: JSON.stringify(byOutcome),
  });
}

main()
  .catch((error) => {
    run.fail(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
