/**
 * Order-email transport boundary (Phase 8).
 *
 * Deliberately separate from `src/server/auth/mailer.ts`'s `Mailer`
 * interface (password reset, email verification) — that interface and its
 * behaviour are unchanged by this work, though both now share one
 * transport-selection function, `resolveEmailTransport()`
 * (`src/server/email/transport.ts`), so the two can never silently drift
 * apart on when a real provider may be selected.
 *
 * Three implementations: `ResendOrderMailer` (the real transport, selected
 * by `EMAIL_TRANSPORT=resend`), `LocalPreviewOrderMailer` (writes the
 * fully-rendered message to a local, gitignored directory for developer
 * review — a PREVIEW, not delivery, nothing leaves this machine; the
 * default outside production), and the test-only `FakeOrderMailer`
 * (`tests/integration/helpers/order-mailer.ts`).
 *
 * Only relative imports here (with explicit `.ts` extensions, which
 * `tsconfig.json`'s `allowImportingTsExtensions` permits) — this module
 * tree is also imported by `scripts/dispatch-emails.ts`, a plain `node
 * scripts/dispatch-emails.ts` CLI script that cannot resolve the `@/` path
 * alias (a bundler-only feature). Same constraint `prisma/seed.ts` already
 * documents for itself. `resolveEmailTransport()` and `sendViaResend()`
 * live under `src/server/email/` specifically because that tree has zero
 * imports of its own, so it's reachable via a relative path from here.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveEmailTransport } from "../email/transport.ts";
import { ResendApiError, sendViaResend } from "../email/resend-client.ts";
import { errorFields, logError } from "../observability/logger.ts";

export interface OrderEmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * Stable per-`OrderEmail`-row idempotency key (see schema.prisma), the
   * same value on every attempt for this row. A transport that supports
   * provider-side idempotency can use this to avoid a true double-send on
   * retry; a real transport not yet chosen, so this is not itself proof of
   * exactly-once delivery — see `email-outbox.ts`'s module comment.
   */
  idempotencyKey: string;
  /** For the preview transport's filename only — never logged in full. */
  orderNumber: string;
  type: "ORDER_CONFIRMATION" | "SHIPPING_NOTIFICATION";
}

export interface OrderMailer {
  send(message: OrderEmailMessage): Promise<void>;
}

const PREVIEW_DIR = join(process.cwd(), ".local", "email-previews");

/**
 * Writes the rendered message to `.local/email-previews/` — outside
 * `public/`, outside source control (`.gitignore`'d), local to this
 * machine only. This is a developer PREVIEW, never delivery: no network
 * call is made, nothing is sent to the recipient. Logs only a redacted,
 * non-PII line (order number + email type, both already routine identifiers
 * elsewhere in this app's own logs/URLs) — never the recipient address,
 * subject, or body.
 */
export class LocalPreviewOrderMailer implements OrderMailer {
  async send(message: OrderEmailMessage): Promise<void> {
    await mkdir(PREVIEW_DIR, { recursive: true });
    const safeOrderNumber = message.orderNumber.replace(/[^a-zA-Z0-9_-]/g, "_");
    const base = `${Date.now()}-${safeOrderNumber}-${message.type}`;
    await writeFile(join(PREVIEW_DIR, `${base}.html`), message.html, "utf8");
    await writeFile(join(PREVIEW_DIR, `${base}.txt`), message.text, "utf8");
    console.info(
      "[order-mailer:preview] wrote a local preview for order %s (%s) — not sent, no real transport is configured this milestone",
      message.orderNumber,
      message.type,
    );
  }
}

/**
 * The real transport. Constructed only when `resolveEmailTransport()` has
 * already confirmed `EMAIL_TRANSPORT=resend` with both `RESEND_API_KEY` and
 * `EMAIL_FROM_ADDRESS` present, and that this is not a test run — see that
 * function for the full fail-closed reasoning (shared with
 * `src/server/auth/mailer.ts`).
 *
 * Uses the job's own `idempotencyKey` as Resend's `Idempotency-Key` header
 * — Resend de-duplicates by that key for 24 hours (see
 * `resend-client.ts`'s module comment). This makes a retry of the SAME
 * claimed job (the outbox's own backoff, or a crash-recovered stale claim)
 * safe against a genuine double-send at the provider, within that window —
 * it does not, on its own, make this exactly-once delivery; see
 * `email-outbox.ts`'s own "not exactly-once" note, which this transport
 * does not change.
 */
export class ResendOrderMailer implements OrderMailer {
  // Explicit fields, NOT constructor parameter properties: this module is loaded
  // by `scripts/dispatch-emails.ts` under plain `node` (type-stripping only),
  // which rejects parameter properties with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX —
  // that made the whole email job unrunnable before this was found by running it
  // from the production image. Keep this file erasable-syntax-only.
  private readonly apiKey: string;
  private readonly from: string;

  constructor(apiKey: string, from: string) {
    this.apiKey = apiKey;
    this.from = from;
  }

  async send(message: OrderEmailMessage): Promise<void> {
    try {
      await sendViaResend({
        apiKey: this.apiKey,
        from: this.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        idempotencyKey: message.idempotencyKey,
      });
    } catch (error) {
      // Never log the recipient address, the message body, or the provider's response text
      // (it can echo request data) — only the order number/type, the HTTP status and a category.
      logError("order_email.send_failed", {
        orderNumber: message.orderNumber,
        templateType: message.type,
        providerStatus: error instanceof ResendApiError ? error.status : null,
        retryable: error instanceof ResendApiError ? error.retryable : null,
        ...errorFields(error),
      });
      throw error;
    }
  }
}

let mailer: OrderMailer | null = null;

function resolveMailer(): OrderMailer {
  const transport = resolveEmailTransport();
  if (transport.name === "resend") {
    const { apiKey, from } = transport.resend!;
    return new ResendOrderMailer(apiKey, from);
  }
  // "noop" has no order-email-specific meaning distinct from the local
  // preview transport (there is no bare no-op `OrderMailer` — unlike auth's
  // `NoopMailer`, an order confirmation with nothing recorded anywhere,
  // not even a local file, has no legitimate use even in development) —
  // both non-"resend" transport names resolve to the same local preview
  // behaviour here.
  return new LocalPreviewOrderMailer();
}

/**
 * The active order-email transport. Lazily resolved so
 * `resolveEmailTransport()`'s checks run against the real environment at
 * first use, not at module load.
 */
export function getOrderMailer(): OrderMailer {
  if (!mailer) mailer = resolveMailer();
  return mailer;
}

/** Test seam. */
export function __setOrderMailer(next: OrderMailer | null): void {
  mailer = next;
}
