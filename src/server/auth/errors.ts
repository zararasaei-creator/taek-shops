/**
 * Typed authentication / authorization errors.
 *
 * Every error carries a machine `code`, an HTTP `status`, and a `publicMessage`
 * that is deliberately safe to show a user (no account-existence disclosure, no
 * internal detail). Route handlers map these to responses; nothing else should
 * invent ad-hoc auth error strings.
 */

export type AuthErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "invalid_credentials"
  | "account_disabled"
  | "email_not_verified"
  | "rate_limited"
  | "weak_password"
  | "invalid_token"
  | "self_role_change"
  | "privilege_escalation"
  | "validation"
  | "email_delivery_failed";

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly status: number;
  readonly publicMessage: string;

  constructor(
    code: AuthErrorCode,
    status: number,
    publicMessage: string,
    internalMessage?: string,
  ) {
    super(internalMessage ?? publicMessage);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

export class UnauthenticatedError extends AuthError {
  constructor(internal?: string) {
    super("unauthenticated", 401, "Authentication required.", internal);
  }
}

export class ForbiddenError extends AuthError {
  constructor(internal?: string) {
    super("forbidden", 403, "You do not have permission to perform this action.", internal);
  }
}

/** Used for BOTH unknown email and wrong password — never distinguish the two. */
export class InvalidCredentialsError extends AuthError {
  constructor(internal?: string) {
    super("invalid_credentials", 401, "Invalid email or password.", internal);
  }
}

export class AccountDisabledError extends AuthError {
  constructor(internal?: string) {
    super("account_disabled", 403, "This account is not able to sign in.", internal);
  }
}

export class RateLimitedError extends AuthError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, internal?: string) {
    super("rate_limited", 429, "Too many attempts. Please try again later.", internal);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class WeakPasswordError extends AuthError {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super("weak_password", 422, "Password does not meet the requirements.");
    this.reasons = reasons;
  }
}

export class InvalidTokenError extends AuthError {
  constructor(internal?: string) {
    super("invalid_token", 400, "This link is invalid or has expired.", internal);
  }
}

/**
 * An email could not be requested from the transport. Only raised on flows
 * where the caller is already authenticated (so nothing is enumerable) — the
 * public flows stay generic by design.
 */
export class EmailSendFailedError extends AuthError {
  constructor(internal?: string) {
    super(
      "email_delivery_failed",
      502,
      "We couldn't send the email just now. Your account is fine — please try again in a few minutes.",
      internal,
    );
  }
}

export class SelfRoleChangeError extends AuthError {
  constructor() {
    super("self_role_change", 403, "You cannot change your own role.");
  }
}

export class PrivilegeEscalationError extends AuthError {
  constructor(internal?: string) {
    super("privilege_escalation", 403, "You cannot grant a role at or above your own.", internal);
  }
}

export function isAuthError(error: unknown): error is AuthError {
  return error instanceof AuthError;
}
