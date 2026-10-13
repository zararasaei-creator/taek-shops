/**
 * Durable order-email outbox (Phase 8).
 *
 * Design:
 * - `enqueueOrderEmailTx` inserts the `OrderEmail` job row INSIDE the
 *   caller's own transaction, alongside the qualifying state change (order
 *   paid, or fulfilment reaching FULFILLED) — both commit together, or
 *   neither does. A transport failure can therefore never undo an already-
 *   committed payment or fulfilment change, and a rolled-back state change
 *   never leaves a stray job behind.
 * - `@@unique([orderId, type])` (schema.prisma) makes the insert itself
 *   idempotent: a redelivered webhook or any other duplicate qualifying
 *   event hits that constraint and is silently absorbed by
 *   `enqueueOrderEmailTx` — never a second job, never an error surfaced to
 *   the caller.
 * - `claimNextEmailJob` claims exactly one eligible job atomically via
 *   `SELECT ... FOR UPDATE SKIP LOCKED`: concurrent callers never claim the
 *   same row (each gets a different one, or none). A job whose claiming
 *   worker crashed before resolving it (stuck in `SENDING` past
 *   `STALE_CLAIM_MS`) becomes eligible again — recovery of interrupted
 *   jobs, not just of never-attempted ones.
 * - The actual network call (`OrderMailer.send`) happens OUTSIDE any
 *   transaction, exactly once per claim, using the row's own stable
 *   `idempotencyKey` (generated once at insert, immutable — see
 *   schema.prisma). Bounded retries with exponential backoff
 *   (`backoffMs`), a hard `maxAttempts` cap after which the job is
 *   terminally `FAILED`.
 * - `kickEmailDispatch` is a best-effort, single-job, NEVER-throwing
 *   attempt fired right after a qualifying transaction commits — it gives
 *   near-immediate delivery in the common case but is not the durable path.
 *   `drainEmailQueue` (used by `scripts/dispatch-emails.ts`) is: it loops
 *   claiming and sending until nothing is currently due, independent of any
 *   customer request, so retries and crash-recovery don't depend on new
 *   traffic arriving.
 *
 * **Not exactly-once delivery — stated honestly.** A unique row and a
 * stable idempotency key are NOT the same thing as a provider-verified
 * exactly-once guarantee. If the process crashes after `OrderMailer.send`
 * genuinely reaches a real transport but before this module commits `SENT`,
 * the job is retried and `send` is called again with the SAME
 * `idempotencyKey`. That retry is safe only if the transport itself
 * recognizes and de-duplicates that key server-side (as, for example,
 * Stripe does for its own idempotency keys). Neither local transport this
 * milestone ships (`LocalPreviewOrderMailer`, the test `FakeOrderMailer`)
 * implements any such de-duplication — they are not real providers. So this
 * system provides **at-least-once delivery with a stable idempotency key
 * ready for a provider that honours it**, not a verified exactly-once
 * guarantee. Do not claim otherwise until a real, idempotency-aware
 * transport is in place and that behaviour is actually tested against it.
 *
 * Only relative imports here (see `order-mailer.ts`'s module comment) —
 * `db` is a REQUIRED parameter on every exported function for the same
 * reason: this module is imported both by application code (which has a
 * shared `@/server/db/client` singleton to pass) and by
 * `scripts/dispatch-emails.ts` (a plain `node` CLI script with its own
 * standalone `PrismaClient`, which cannot resolve the `@/` alias at all) —
 * a default value here would have to pick one of those, so instead neither
 * is assumed and every caller is explicit.
 */

import { OrderEmailStatus, OrderEmailType, Prisma, type PrismaClient } from "@prisma/client";

import { getOrderMailer, type OrderMailer } from "./order-mailer.ts";
import { ResendApiError } from "../email/resend-client.ts";
import { errorFields, logError } from "../observability/logger.ts";
import {
  renderOrderConfirmationEmail,
  renderShippingNotificationEmail,
  type OrderEmailSnapshot,
} from "./templates.ts";

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Enqueue an order-email job, composable inside the caller's own
 * transaction. Idempotent: absorbs the unique-constraint violation from a
 * duplicate qualifying event rather than throwing.
 */
export async function enqueueOrderEmailTx(
  tx: Tx,
  orderId: string,
  type: OrderEmailType,
): Promise<void> {
  try {
    await tx.orderEmail.create({ data: { orderId, type } });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
}

const BACKOFF_BASE_MS = 30_000; // 30s
const BACKOFF_CAP_MS = 30 * 60_000; // 30m
const DEFAULT_STALE_CLAIM_MS = 2 * 60_000; // a claimed-but-unresolved job is reclaimable after this

/** Exponential backoff from the attempt count, capped. */
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(attempts - 1, 0), BACKOFF_CAP_MS);
}

export interface ClaimedEmailJob {
  id: string;
  orderId: string;
  type: OrderEmailType;
  idempotencyKey: string;
  attempts: number;
  maxAttempts: number;
}

export interface ClaimOptions {
  workerId?: string;
  /** Override for tests — how long a `SENDING` job must sit unresolved before it's reclaimable. */
  staleClaimMs?: number;
}

/**
 * Atomically claim ONE eligible job. `FOR UPDATE SKIP LOCKED` means
 * concurrent callers racing this same query each get a DIFFERENT row (or
 * `null` once none remain) — never the same row twice, never a block/wait
 * on another claimant's lock.
 */
export async function claimNextEmailJob(
  db: Db,
  opts: ClaimOptions = {},
): Promise<ClaimedEmailJob | null> {
  const workerId = opts.workerId ?? `pid:${process.pid}`;
  const staleCutoff = new Date(Date.now() - (opts.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS));

  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      {
        id: string;
        orderId: string;
        type: OrderEmailType;
        idempotencyKey: string;
        attempts: number;
        maxAttempts: number;
      }[]
    >(Prisma.sql`
      SELECT "id", "orderId", "type", "idempotencyKey", "attempts", "maxAttempts"
      FROM "OrderEmail"
      WHERE ("status" = 'PENDING' AND "nextAttemptAt" <= now())
         OR ("status" = 'SENDING' AND "claimedAt" < ${staleCutoff})
      ORDER BY "nextAttemptAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    const row = rows[0];
    if (!row) return null;

    await tx.orderEmail.update({
      where: { id: row.id },
      data: {
        status: OrderEmailStatus.SENDING,
        claimedAt: new Date(),
        claimedBy: workerId,
        attempts: { increment: 1 },
      },
    });

    return { ...row, attempts: row.attempts + 1 };
  });
}

export async function resolveEmailJobSuccess(db: Db, jobId: string): Promise<void> {
  await db.orderEmail.update({
    where: { id: jobId },
    data: { status: OrderEmailStatus.SENT, sentAt: new Date(), lastError: null },
  });
}

export async function resolveEmailJobFailure(
  db: Db,
  job: ClaimedEmailJob,
  error: unknown,
): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  // A `ResendApiError` marked non-retryable (bad API key, unverified
  // sending domain, a malformed request — see `resend-client.ts`'s
  // classification) will never succeed on a later attempt with the same
  // configuration. Failing the job immediately, rather than burning through
  // `maxAttempts` with exponential backoff first, surfaces a real
  // misconfiguration in minutes instead of up to ~15 (the sum of this
  // outbox's own backoff schedule), without changing behaviour at all for
  // any other kind of failure (network errors, timeouts, 429/5xx, or a
  // plain `Error` from a non-Resend transport) — those still retry exactly
  // as before.
  const nonRetryable = error instanceof ResendApiError && !error.retryable;
  const exhausted = job.attempts >= job.maxAttempts || nonRetryable;
  await db.orderEmail.update({
    where: { id: job.id },
    data: exhausted
      ? { status: OrderEmailStatus.FAILED, lastError: message }
      : {
          status: OrderEmailStatus.PENDING,
          nextAttemptAt: new Date(Date.now() + backoffMs(job.attempts)),
          lastError: message,
        },
  });
}

interface OrderSnapshotRow extends OrderEmailSnapshot {
  recipient: string;
}

async function loadOrderSnapshot(db: Db, orderId: string): Promise<OrderSnapshotRow> {
  const order = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      orderNumber: true,
      currency: true,
      customerEmail: true,
      subtotalCents: true,
      discountCents: true,
      shippingCents: true,
      taxCents: true,
      totalCents: true,
      items: {
        orderBy: { createdAt: "asc" },
        select: {
          productName: true,
          variantName: true,
          sku: true,
          quantity: true,
          unitPriceCents: true,
          lineTotalCents: true,
        },
      },
      addresses: {
        where: { type: "SHIPPING" },
        select: {
          firstName: true,
          lastName: true,
          line1: true,
          line2: true,
          city: true,
          province: true,
          postalCode: true,
          country: true,
        },
      },
    },
  });

  return {
    orderNumber: order.orderNumber,
    currency: order.currency,
    items: order.items,
    subtotalCents: order.subtotalCents,
    discountCents: order.discountCents,
    shippingCents: order.shippingCents,
    taxCents: order.taxCents,
    totalCents: order.totalCents,
    shippingAddress: order.addresses[0] ?? null,
    recipient: order.customerEmail,
  };
}

/** Render, send, and resolve ONE already-claimed job. Never throws. */
export async function sendClaimedJob(
  db: Db,
  job: ClaimedEmailJob,
  mailer: OrderMailer = getOrderMailer(),
): Promise<void> {
  try {
    const snapshot = await loadOrderSnapshot(db, job.orderId);
    const rendered =
      job.type === OrderEmailType.ORDER_CONFIRMATION
        ? renderOrderConfirmationEmail(snapshot)
        : renderShippingNotificationEmail(snapshot);

    await mailer.send({
      to: snapshot.recipient,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      idempotencyKey: job.idempotencyKey,
      orderNumber: snapshot.orderNumber,
      type: job.type,
    });

    await resolveEmailJobSuccess(db, job.id);
  } catch (error) {
    await resolveEmailJobFailure(db, job, error);
  }
}

/**
 * Best-effort, single-job dispatch — fired right after a qualifying
 * transaction commits. Never throws: a transport failure here must never
 * interfere with the already-committed payment or fulfilment change. Only
 * ever attempts the FIRST currently-due job; anything needing a retry or
 * recovery is left for `drainEmailQueue` (the local dispatcher command / a
 * scheduled job in a real deployment), not repeated here.
 */
export async function kickEmailDispatch(db: Db): Promise<void> {
  try {
    const job = await claimNextEmailJob(db);
    if (!job) return;
    await sendClaimedJob(db, job);
  } catch (error) {
    // Best-effort by design (the scheduled `emails:dispatch` retries) — but never silent, and
    // category-only: the raw message of a provider/database error can echo request data.
    logError("order_email.dispatch_kick_failed", errorFields(error));
  }
}

export interface DrainResult {
  claimed: number;
  sent: number;
  notSent: number;
}

/**
 * Drain every currently-due job: claim, send, resolve, repeat until nothing
 * is left eligible. Terminates naturally — a job that goes back to PENDING
 * with a future `nextAttemptAt` (backoff) is not due yet, so it's not
 * re-claimed in the same pass. Used by `scripts/dispatch-emails.ts`.
 */
export async function drainEmailQueue(db: Db): Promise<DrainResult> {
  let claimed = 0;
  let sent = 0;
  let notSent = 0;

  for (;;) {
    const job = await claimNextEmailJob(db);
    if (!job) break;
    claimed += 1;

    await sendClaimedJob(db, job);

    const row = await db.orderEmail.findUniqueOrThrow({
      where: { id: job.id },
      select: { status: true },
    });
    if (row.status === OrderEmailStatus.SENT) sent += 1;
    else notSent += 1;
  }

  return { claimed, sent, notSent };
}
