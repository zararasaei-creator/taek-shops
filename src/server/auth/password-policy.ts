/**
 * The one place password rules live.
 *
 * Guidance followed: NIST SP 800-63B — favour length and a breached-password
 * check over composition rules (no forced "1 upper + 1 symbol"). Rules are
 * deliberately moderate for a consumer e-commerce site.
 */

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128; // bound work + avoid absurd inputs

/**
 * Small embedded list of the most common / obviously weak passwords. This is not
 * a substitute for a breached-password API (see `docs/security.md` — deferred),
 * but blocks the worst offenders offline.
 */
const COMMON_PASSWORDS = new Set(
  [
    "password",
    "password1",
    "password123",
    "passw0rd",
    "12345678",
    "123456789",
    "1234567890",
    "qwertyuiop",
    "qwerty123",
    "letmein123",
    "welcome123",
    "admin123",
    "iloveyou1",
    "taekwondo",
    "taekshops",
    "changeme",
    "changeme123",
    "secret123",
    "111111111",
    "aaaaaaaaaa",
  ].map((value) => value.toLowerCase()),
);

export interface PasswordContext {
  /** Reject passwords derived from the user's own email (local-part / full). */
  email?: string | null;
  /** Reject passwords containing the user's name. */
  firstName?: string | null;
  lastName?: string | null;
}

/**
 * Returns a list of human-readable failure reasons. Empty list == acceptable.
 */
export function validatePassword(password: string, context: PasswordContext = {}): string[] {
  const reasons: string[] = [];
  const value = password ?? "";

  if (value.length < PASSWORD_MIN_LENGTH) {
    reasons.push(`Must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (value.length > PASSWORD_MAX_LENGTH) {
    reasons.push(`Must be at most ${PASSWORD_MAX_LENGTH} characters.`);
  }
  if (/^\s|\s$/.test(value)) {
    reasons.push("Must not start or end with whitespace.");
  }
  if (new Set(value).size <= 4 && value.length > 0) {
    reasons.push("Must not be a small set of repeated characters.");
  }

  const lower = value.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) {
    reasons.push("This password is too common.");
  }

  const personal: string[] = [];
  if (context.email) {
    const [localPart] = context.email.toLowerCase().split("@");
    if (localPart && localPart.length >= 3) personal.push(localPart);
    personal.push(context.email.toLowerCase());
  }
  if (context.firstName && context.firstName.length >= 3) {
    personal.push(context.firstName.toLowerCase());
  }
  if (context.lastName && context.lastName.length >= 3) {
    personal.push(context.lastName.toLowerCase());
  }
  if (personal.some((fragment) => lower.includes(fragment))) {
    reasons.push("Must not contain your name or email.");
  }

  return reasons;
}

export function isPasswordAcceptable(password: string, context?: PasswordContext): boolean {
  return validatePassword(password, context).length === 0;
}
