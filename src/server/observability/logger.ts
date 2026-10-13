/**
 * Shared structured logger (Phase 13, operational-error visibility).
 *
 * One JSON object per line: `info`/`debug` to stdout, `warn`/`error` to stderr — what any
 * container log collector (Docker, systemd, a hosting platform) already captures. No
 * third-party SDK, no network, no files, no state.
 *
 *   {"ts":"2026-10-08T14:00:00.000Z","level":"error","event":"stripe_webhook.processing_failed",
 *    "service":"taek-shops","eventId":"evt_…","errorCategory":"database:P2002"}
 *
 * **Zero imports and erasable-only TypeScript on purpose.** `scripts/dispatch-emails.ts` and
 * `scripts/cleanup-image-uploads.ts` run under plain `node` (type-stripping, no `@/` alias), and
 * so does everything they import — see `tests/unit/job-scripts-loadable.test.ts`.
 *
 * **Privacy is enforced here, not left to each call site** (defence in depth; call sites should
 * still pass only what they need):
 *  - Only primitive field values are accepted; objects/arrays/functions are dropped.
 *  - A field whose NAME suggests sensitive content (password, secret, token, cookie,
 *    authorization, key, url, email, address, phone, name, payload, body, card, …) is replaced
 *    by "[redacted]" regardless of its value.
 *  - String VALUES are scanned for secret shapes (Stripe/Resend keys and webhook secrets, bearer
 *    tokens, connection strings, email addresses, JWT-like blobs) and redacted, then truncated.
 *  - Limit, stated plainly: a bare secret with no recognisable shape, sitting in a free-text field with an
 *    innocuous name, cannot be detected. That is why errors are category-only and call sites pass
 *    identifiers and counts, never free text.
 *  - Errors are logged ONLY as a category (`errorFields`) — never `error.message`, never the raw
 *    object, never a stack: provider and database messages can echo request data, keys or
 *    customer details.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogValue>;

export const SERVICE_NAME = "taek-shops";
const REDACTED = "[redacted]";
const MAX_STRING = 300;

/** Field names that must never carry a value into the log. Matched case-insensitively as substrings. */
const SENSITIVE_KEY =
  /pass(word|wd)?|secret|token|cookie|authoriz|credential|api[-_]?key|apikey|(^|[^a-z])key($|[^a-z])|connection|dsn|(^|[^a-z])url($|[^a-z])|uri$|email|e-mail|address|phone|street|postal|(first|last|full|customer)?name$|payload|body|signature|card|iban|ssn|session|csrf|bearer|private/i;
/** …except these deliberately-safe identifiers that happen to match (e.g. `eventId` is fine; `eventType` too). */
const SAFE_KEY_ALLOWLIST = new Set([
  "event",
  "errorName",
  "errorCategory",
  "job",
  "runId",
  "status",
  "durationMs",
  "storageKey",
]);

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]+/g, // Stripe API keys
  /\bwhsec_[A-Za-z0-9]+/g, // Stripe webhook signing secrets
  /\bre_[A-Za-z0-9_]{8,}/g, // Resend API keys
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/gi, // scheme://user:password@host…
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, // JWT-shaped
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, // email addresses
];

function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, REDACTED);
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…` : out;
}

function isSensitiveKey(key: string): boolean {
  if (SAFE_KEY_ALLOWLIST.has(key)) return false;
  // camelCase -> snake_case first, so "databaseUrl" is seen as "database_Url" (word boundaries).
  return SENSITIVE_KEY.test(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
}

/** Exported for tests. Returns a plain object safe to serialise. */
export function sanitizeFields(fields: LogFields | undefined): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!fields) return out;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    if (value === null || typeof value === "boolean") out[key] = value;
    else if (typeof value === "number") out[key] = Number.isFinite(value) ? value : null;
    else if (typeof value === "string") out[key] = redactString(value);
    // anything else (object, array, function, symbol, bigint) is dropped on purpose
  }
  return out;
}

// ---- output -----------------------------------------------------------------------------

export type LogSink = (level: LogLevel, line: string) => void;

const defaultSink: LogSink = (level, line) => {
  const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
};
let sink: LogSink = defaultSink;

/** Test seam: capture log lines. Pass `null` to restore stdout/stderr. */
export function __setLogSink(next: LogSink | null): void {
  sink = next ?? defaultSink;
}

/** The reserved envelope keys win over any caller field with the same name. */
export function logEvent(level: LogLevel, event: string, fields?: LogFields): void {
  const line = JSON.stringify({
    ...sanitizeFields(fields),
    ts: new Date().toISOString(),
    level,
    event,
    service: SERVICE_NAME,
  });
  try {
    sink(level, line);
  } catch {
    // Logging must never break the operation it describes.
  }
}

export const logInfo = (event: string, fields?: LogFields): void => logEvent("info", event, fields);
export const logWarn = (event: string, fields?: LogFields): void => logEvent("warn", event, fields);
export const logError = (event: string, fields?: LogFields): void => logEvent("error", event, fields);

// ---- errors: category only ----------------------------------------------------------------

/**
 * A SAFE description of an error: a stable category plus the class name — never the message,
 * stack, cause, or any property of the error. Duck-typed (no imports) so it works in every
 * runtime this project uses.
 *   database:<Pxxxx>     Prisma request error with its code (e.g. database:P2002)
 *   database:connection  Prisma could not reach / initialise the database
 *   provider:ambiguous   payment-provider failure with an unknown outcome (network/timeout/409)
 *   provider:declined    payment-provider definitive refusal
 *   signature            webhook signature verification failure
 *   validation           schema/validation failure
 *   timeout              a timeout we raised
 *   unexpected           anything else
 */
export function errorCategory(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unexpected";
  const e = error as { name?: unknown; code?: unknown; ambiguous?: unknown };
  const name = typeof e.name === "string" ? e.name : "";
  if (name === "PrismaClientKnownRequestError") {
    return typeof e.code === "string" && /^P\d{4}$/.test(e.code) ? `database:${e.code}` : "database:unknown";
  }
  if (name === "PrismaClientInitializationError" || name === "PrismaClientRustPanicError") return "database:connection";
  if (name === "PrismaClientValidationError" || name === "PrismaClientUnknownRequestError") return "database:other";
  if (name === "PaymentGatewayError") return e.ambiguous === true ? "provider:ambiguous" : "provider:declined";
  if (name === "WebhookSignatureError") return "signature";
  if (name === "ZodError") return "validation";
  if (name === "TimeoutError") return "timeout";
  return "unexpected";
}

/** Fields to spread into a log call: `errorName` (class name only) and `errorCategory`. */
export function errorFields(error: unknown): { errorName: string; errorCategory: string } {
  const name =
    typeof error === "object" && error !== null && typeof (error as { name?: unknown }).name === "string"
      ? (error as { name: string }).name
      : typeof error;
  return { errorName: /^[A-Za-z0-9_$.]{1,60}$/.test(name) ? name : "Error", errorCategory: errorCategory(error) };
}

// ---- job runs ------------------------------------------------------------------------------

export type JobStatus = "ok" | "completed_with_errors" | "attention_required" | "skipped";

export interface JobRun {
  readonly runId: string;
  /** Normal end of the run. Warns (instead of info) unless `status` is "ok". */
  finish(status: JobStatus, fields?: LogFields): void;
  /** The run threw. Logs a category only; the caller keeps its own non-zero exit. */
  fail(error: unknown, fields?: LogFields): void;
}

/**
 * Wraps a job (cron-style CLI) with `job.started`, then exactly one of `job.completed` /
 * `job.failed`, each carrying `job`, `runId` (correlates the lines of one run) and
 * `durationMs`. Does NOT touch the process exit code — each script keeps its own existing
 * non-zero-exit behaviour.
 */
export function startJobRun(job: string): JobRun {
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const startedAt = Date.now();
  logInfo("job.started", { job, runId });
  const elapsed = () => Date.now() - startedAt;
  return {
    runId,
    finish(status, fields) {
      logEvent(status === "ok" ? "info" : "warn", "job.completed", { ...fields, job, runId, status, durationMs: elapsed() });
    },
    fail(error, fields) {
      logError("job.failed", { ...fields, job, runId, status: "failed", durationMs: elapsed(), ...errorFields(error) });
    },
  };
}
