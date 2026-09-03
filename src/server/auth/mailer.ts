/**
 * Mailer seam.
 *
 * Phase 3 has no email delivery. This interface exists so the password-reset and
 * email-verification *foundations* have a real place to hand off a token. The
 * default `NoopMailer` logs that a message would be sent — never the token
 * itself. A real transport (Resend / SES / SMTP) is Phase 4+ work.
 */

export interface VerificationEmail {
  to: string;
  /** The raw token — passed to the transport, never logged. */
  token: string;
}

export interface Mailer {
  sendPasswordReset(email: VerificationEmail): Promise<void>;
  sendEmailVerification(email: VerificationEmail): Promise<void>;
}

export class NoopMailer implements Mailer {
  async sendPasswordReset({ to }: VerificationEmail): Promise<void> {
    console.info("[mailer:noop] password reset email suppressed for %s", redactEmail(to));
  }

  async sendEmailVerification({ to }: VerificationEmail): Promise<void> {
    console.info("[mailer:noop] verification email suppressed for %s", redactEmail(to));
  }
}

function redactEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain || !local) return "***";
  return `${local.slice(0, 2)}***@${domain}`;
}

export const mailer: Mailer = new NoopMailer();
