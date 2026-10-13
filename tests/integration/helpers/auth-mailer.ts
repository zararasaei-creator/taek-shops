import type { Mailer, VerificationEmail } from "@/server/auth/mailer";

/**
 * A controlled `Mailer` for integration tests — never writes a real preview
 * file, never touches the network. Records every call's type and the raw
 * token (so a test can drive a real confirm/consume call with it) without
 * ever logging either. Mirrors `FakeOrderMailer`'s own shape and purpose.
 */
export class FakeMailer implements Mailer {
  readonly passwordResetCalls: VerificationEmail[] = [];
  readonly emailVerificationCalls: VerificationEmail[] = [];

  async sendPasswordReset(email: VerificationEmail): Promise<void> {
    this.passwordResetCalls.push(email);
  }

  async sendEmailVerification(email: VerificationEmail): Promise<void> {
    this.emailVerificationCalls.push(email);
  }
}
