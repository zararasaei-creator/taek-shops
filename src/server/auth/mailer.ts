/**
 * Mailer seam — password reset and email verification.
 *
 * Three implementations, selected by `resolveEmailTransport()`
 * (`src/server/email/transport.ts`, shared with the order-email outbox):
 * - `ResendMailer` — the real transport, selected by `EMAIL_TRANSPORT=resend`.
 * - `LocalPreviewMailer` — writes the rendered message to
 *   `.local/email-previews/` (the same gitignored, outside-`public/`
 *   directory `LocalPreviewOrderMailer` already uses) for local developer
 *   review. Nothing is sent anywhere. This is the default outside
 *   production.
 * - `NoopMailer` — logs only that a message would have been sent (never the
 *   token). Kept for explicit `EMAIL_TRANSPORT=noop` use (e.g. a test
 *   fixture that wants zero filesystem writes); no longer the default.
 *
 * `resolveEmailTransport()` refuses to let production silently fall back to
 * either local transport, and refuses to let any test run select the real
 * one even if real credentials happen to be configured — see that
 * function's own comment.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { clientEnv } from "@/server/config/env";
import { resolveEmailTransport } from "@/server/email/transport";
import { ResendApiError, sendViaResend } from "@/server/email/resend-client";
import { renderEmailVerificationEmail, renderPasswordResetEmail } from "@/server/auth/mailer-templates";

export interface VerificationEmail {
  to: string;
  /** The raw token — passed to the transport, never logged. */
  token: string;
}

export interface Mailer {
  sendPasswordReset(email: VerificationEmail): Promise<void>;
  sendEmailVerification(email: VerificationEmail): Promise<void>;
}

function redactEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain || !local) return "***";
  return `${local.slice(0, 2)}***@${domain}`;
}

export class NoopMailer implements Mailer {
  async sendPasswordReset({ to }: VerificationEmail): Promise<void> {
    console.info("[mailer:noop] password reset email suppressed for %s", redactEmail(to));
  }

  async sendEmailVerification({ to }: VerificationEmail): Promise<void> {
    console.info("[mailer:noop] verification email suppressed for %s", redactEmail(to));
  }
}

const PREVIEW_DIR = join(process.cwd(), ".local", "email-previews");

/**
 * Writes each rendered message to `.local/email-previews/` — outside
 * `public/`, outside source control, local to this machine only. A
 * developer PREVIEW, never delivery: no network call, nothing sent to the
 * recipient. Logs only a redacted, non-PII line (which email type, and the
 * local/domain-truncated address already routine elsewhere in this app's
 * logs) — never the raw token, the full address, or the message body.
 */
export class LocalPreviewMailer implements Mailer {
  private async writePreview(type: "password-reset" | "email-verification", to: string, token: string): Promise<void> {
    await mkdir(PREVIEW_DIR, { recursive: true });
    const rendered =
      type === "password-reset"
        ? renderPasswordResetEmail(token, clientEnv.NEXT_PUBLIC_APP_URL)
        : renderEmailVerificationEmail(token, clientEnv.NEXT_PUBLIC_APP_URL);
    const base = `${Date.now()}-${type}`;
    await writeFile(join(PREVIEW_DIR, `${base}.html`), rendered.html, "utf8");
    await writeFile(join(PREVIEW_DIR, `${base}.txt`), rendered.text, "utf8");
    console.info("[mailer:preview] wrote a local preview (%s) for %s — not sent", type, redactEmail(to));
  }

  async sendPasswordReset({ to, token }: VerificationEmail): Promise<void> {
    await this.writePreview("password-reset", to, token);
  }

  async sendEmailVerification({ to, token }: VerificationEmail): Promise<void> {
    await this.writePreview("email-verification", to, token);
  }
}

/**
 * The real transport. Constructed only when `resolveEmailTransport()` has
 * already confirmed `EMAIL_TRANSPORT=resend` with both `RESEND_API_KEY` and
 * `EMAIL_FROM_ADDRESS` present, and that this is not a test run — see that
 * function for the full fail-closed reasoning.
 */
export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  private async send(
    type: "password-reset" | "email-verification",
    to: string,
    token: string,
  ): Promise<void> {
    const rendered =
      type === "password-reset"
        ? renderPasswordResetEmail(token, clientEnv.NEXT_PUBLIC_APP_URL)
        : renderEmailVerificationEmail(token, clientEnv.NEXT_PUBLIC_APP_URL);
    try {
      await sendViaResend({
        apiKey: this.apiKey,
        from: this.from,
        to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        // Auth emails have no durable outbox/retry of their own (unlike
        // order emails) — a stable per-send idempotency key would need a
        // persisted job id this flow doesn't have. Not set here; a
        // network-level retry of the SAME `fetch` call is not attempted by
        // this module, so the absence of a key does not risk a duplicate
        // send from retries this code itself performs (it performs none).
      });
    } catch (error) {
      // Never log the token, the full recipient address, or the email
      // body. `ResendApiError`'s own message is Resend's response about
      // the REQUEST's acceptance (bad key, unverified domain, rate limit),
      // not about the recipient or content.
      const detail = error instanceof ResendApiError ? error.message : "unexpected error";
      console.error("[mailer:resend] %s send failed for %s: %s", type, redactEmail(to), detail);
      throw error;
    }
  }

  async sendPasswordReset({ to, token }: VerificationEmail): Promise<void> {
    await this.send("password-reset", to, token);
  }

  async sendEmailVerification({ to, token }: VerificationEmail): Promise<void> {
    await this.send("email-verification", to, token);
  }
}

let mailer: Mailer | null = null;

function resolveMailer(): Mailer {
  const transport = resolveEmailTransport();
  if (transport.name === "resend") {
    const { apiKey, from } = transport.resend!;
    return new ResendMailer(apiKey, from);
  }
  if (transport.name === "noop") return new NoopMailer();
  return new LocalPreviewMailer();
}

/** The active mailer. Lazily resolved so `resolveEmailTransport()`'s checks run against the real environment at first use, not at module load. */
export function getMailer(): Mailer {
  if (!mailer) mailer = resolveMailer();
  return mailer;
}

/** Test seam. */
export function __setMailer(next: Mailer | null): void {
  mailer = next;
}
