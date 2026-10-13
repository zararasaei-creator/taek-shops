import { VERIFICATION_TTL_SECONDS } from "@/server/auth/config";

/**
 * Password-reset and email-verification message content. Separate from
 * `src/server/notifications/templates.ts` (order emails) deliberately —
 * that module is relative-import-only for a plain-`node`-script constraint
 * that does not apply here (see its own module comment), and the two
 * template sets render from entirely different data (a token + a link vs.
 * a full order snapshot).
 */

export interface RenderedAuthEmail {
  subject: string;
  html: string;
  text: string;
}

/** Minimal, dependency-free HTML escaping — mirrors `notifications/templates.ts`'s own. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const EXPIRY_MINUTES = Math.round(VERIFICATION_TTL_SECONDS / 60);

export function renderPasswordResetEmail(token: string, appUrl: string): RenderedAuthEmail {
  const link = `${appUrl}/password-reset/confirm?token=${encodeURIComponent(token)}`;
  const safeLink = escapeHtml(link);
  return {
    subject: "Reset your Taek Shops password",
    html:
      `<p>We received a request to reset your Taek Shops password.</p>` +
      `<p><a href="${safeLink}">Reset your password</a></p>` +
      `<p>This link expires in ${EXPIRY_MINUTES} minutes and can only be used once. ` +
      `If you didn't request this, you can ignore this email.</p>`,
    text:
      `We received a request to reset your Taek Shops password.\n\n` +
      `${link}\n\n` +
      `This link expires in ${EXPIRY_MINUTES} minutes and can only be used once. ` +
      `If you didn't request this, you can ignore this email.`,
  };
}

/**
 * Links to `/verify-email?token=...`, whose page requires an explicit
 * button click before the token is consumed (scanner-safe). Email
 * verification is not currently enforced anywhere in this app (no
 * login/checkout path checks `emailVerifiedAt`) — see `registration.ts`
 * for the documented unverified-customer policy.
 */
export function renderEmailVerificationEmail(token: string, appUrl: string): RenderedAuthEmail {
  const link = `${appUrl}/verify-email?token=${encodeURIComponent(token)}`;
  const safeLink = escapeHtml(link);
  return {
    subject: "Verify your Taek Shops email address",
    html:
      `<p>Please confirm your email address for your Taek Shops account.</p>` +
      `<p><a href="${safeLink}">Verify your email</a></p>` +
      `<p>This link expires in ${EXPIRY_MINUTES} minutes and can only be used once.</p>`,
    text:
      `Please confirm your email address for your Taek Shops account.\n\n` +
      `${link}\n\n` +
      `This link expires in ${EXPIRY_MINUTES} minutes and can only be used once.`,
  };
}
