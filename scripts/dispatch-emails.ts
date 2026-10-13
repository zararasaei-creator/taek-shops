/**
 * Local email-outbox dispatcher (Phase 8).
 *
 * Drains every currently-due `OrderEmail` job (PENDING and due, or
 * SENDING-but-abandoned by a crashed worker): claims it, renders the
 * template, sends via whatever `OrderMailer` this process resolves (the
 * local preview transport by default — no real provider exists yet), and
 * records the outcome.
 *
 * This is what makes retries and crash-recovery NOT depend on another
 * customer request: `kickEmailDispatch` (fired best-effort right after a
 * qualifying payment/fulfilment change, see `src/server/notifications/email-outbox.ts`)
 * only ever attempts a job's FIRST send. Anything that needed a retry, or
 * whose claiming process crashed before resolving it, sits in the outbox
 * until this command runs. In a real deployment this should run on a
 * schedule (e.g. every minute) — see `docs/implementation-roadmap.md` for
 * that outstanding production requirement; nothing here schedules itself.
 *
 * Run with:  npm run emails:dispatch
 *
 * Cannot use the `@/` path alias — this runs as a plain `node
 * scripts/dispatch-emails.ts`, outside Next's/Vitest's bundler-aware
 * resolution, so only relative imports (with explicit `.ts` extensions)
 * reach the notifications module. Same constraint `prisma/seed.ts` already
 * documents for itself, and the reason `email-outbox.ts`'s functions all
 * take `db` as a required parameter rather than defaulting to the app's
 * shared `@/server/db/client` singleton.
 */

import { PrismaClient } from "@prisma/client";

import { drainEmailQueue } from "../src/server/notifications/email-outbox.ts";
import { startJobRun } from "../src/server/observability/logger.ts";

const prisma = new PrismaClient();
// Structured events (JSON lines): job.started, then job.completed | job.failed, each with
// job/runId/durationMs. A crash exits non-zero exactly as before. See docs/monitoring.md.
const run = startJobRun("emails:dispatch");

async function main(): Promise<void> {
  const { claimed, sent, notSent } = await drainEmailQueue(prisma);
  // `notSent` = retry-scheduled or failed this pass; they stay in the outbox for a later run.
  run.finish(notSent > 0 ? "completed_with_errors" : "ok", { claimed, sent, notSent });
}

main()
  .catch((error) => {
    run.fail(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
