/**
 * Minimal, dependency-free Resend REST API client — raw `fetch`, not the
 * `resend` npm SDK.
 *
 * Why raw `fetch` and not the SDK: this file has NO imports of any kind
 * (beyond language/runtime globals), which lets it be imported from
 * `src/server/notifications/*` — a module tree that must stay resolvable by
 * `scripts/dispatch-emails.ts`, a plain `node` CLI script that cannot
 * resolve either the `@/` path alias or an npm package import the way
 * Next's/Vitest's bundler-aware resolution can (see `order-mailer.ts`'s own
 * module comment for the established precedent). `fetch`/`AbortSignal` are
 * stable Node globals (this project requires Node >=22.18.0 — see
 * `package.json` `engines` — well past Node 18, where both landed), so no
 * import is needed at all. Calling Resend's REST API directly with `fetch`
 * is also Resend's own documented approach for non-Node-SDK environments
 * (e.g. edge runtimes), not an unsupported workaround.
 *
 * API shape verified directly against Resend's official docs on 2026-10-01
 * (not assumed from memory):
 * - https://resend.com/docs/api-reference/emails/send-email — `POST
 *   https://api.resend.com/emails`, `Authorization: Bearer <key>`, JSON body
 *   `{from, to, subject, html, text}`, success is `200 {"id": "<uuid>"}`.
 * - https://resend.com/docs/dashboard/emails/idempotency-keys — an
 *   `Idempotency-Key` request header (max 256 chars) is de-duplicated by
 *   Resend for 24 hours from first use, on both `POST /emails` and `POST
 *   /emails/batch`. This project's own `OrderEmail.idempotencyKey` is a
 *   `cuid()` (well under 256 chars), and the outbox's own backoff/attempt
 *   cap (30s base, 30 minute cap, 5 attempts by default — `email-outbox.ts`)
 *   keeps any real retry sequence well inside that 24-hour window in normal
 *   operation. If an operator ever manually re-triggers a job more than 24
 *   hours after its first real attempt, Resend's own de-duplication no
 *   longer applies — stated here rather than silently assumed to still
 *   hold.
 * - https://resend.com/docs/api-reference/errors — documented status
 *   codes: 401/403 (invalid API key, unverified/restricted sending domain —
 *   never retryable, no later attempt with the same configuration can
 *   succeed), 400/422 (request validation — never retryable, the content is
 *   the problem), 429 (rate limit — retryable), 5xx (retryable).
 *
 * **What a successful call here proves, and does not prove**: a `200` with
 * an `id` means Resend's API *accepted* the request for delivery. It is NOT
 * proof the message reached an inbox — bounces, spam placement, and
 * provider-side delivery failures all happen *after* this call returns
 * successfully and are invisible to it. Never describe this as "delivered"
 * in any status this project surfaces — "sent" (accepted by the provider)
 * is the honest word, and is what `OrderEmailStatus.SENT` already means
 * (see `email-outbox.ts`'s own "not exactly-once" note, which this applies
 * to equally).
 */

export interface ResendEmailInput {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Resend's own idempotency key, not required. Max 256 chars (Resend's limit; not re-validated here). */
  idempotencyKey?: string;
}

export interface ResendEmailResult {
  /** Resend's own message id. Proof of acceptance, never proof of inbox delivery — see module comment. */
  id: string;
}

export class ResendApiError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(message: string, status: number | null, retryable: boolean) {
    super(message);
    this.name = "ResendApiError";
    this.status = status;
    this.retryable = retryable;
  }
}

const RESEND_API_URL = "https://api.resend.com/emails";
const DEFAULT_TIMEOUT_MS = 10_000;

/** Per Resend's documented status codes (see module comment) — never guessed. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Send one email through Resend's REST API. Never logs anything itself
 * (the caller decides what, if anything, to log) and never includes the
 * recipient, subject, or body in a thrown error's message — only Resend's
 * own response text, which describes the REQUEST's acceptance (bad key,
 * unverified domain, rate limit, …), not its content.
 *
 * `fetchImpl` is an injection point for tests — never used to reach a real
 * endpoint from this module itself; the default is the real global
 * `fetch`.
 */
export async function sendViaResend(
  input: ResendEmailInput,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ResendEmailResult> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.apiKey}`,
    "Content-Type": "application/json",
  };
  if (input.idempotencyKey) headers["Idempotency-Key"] = input.idempotencyKey;

  let response: Response;
  try {
    response = await fetchFn(RESEND_API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        from: input.from,
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Network failure or a timeout (AbortSignal.timeout rejects with a
    // DOMException named "TimeoutError") — always treated as retryable;
    // neither tells us anything about whether Resend itself ever saw the
    // request.
    const message = error instanceof Error ? error.message : String(error);
    throw new ResendApiError(`Resend request failed: ${message}`, null, true);
  }

  if (response.ok) {
    const body = (await response.json().catch(() => null)) as { id?: string } | null;
    if (!body?.id) {
      throw new ResendApiError("Resend returned a 2xx response with no message id.", response.status, false);
    }
    return { id: body.id };
  }

  const bodyText = await response.text().catch(() => "");
  throw new ResendApiError(
    `Resend API returned ${response.status}: ${bodyText.slice(0, 500)}`,
    response.status,
    isRetryableStatus(response.status),
  );
}
