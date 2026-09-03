/**
 * Central authentication configuration. Values that might reasonably change per
 * environment read from validated env; the rest are considered policy constants
 * and live here so there is exactly one place to review them.
 */
import { serverEnv } from "@/server/config/env";

/** Name of the opaque session cookie. */
export const SESSION_COOKIE_NAME = "taek_session";

/** Name of the non-httpOnly double-submit CSRF cookie. */
export const CSRF_COOKIE_NAME = "taek_csrf";

/** Header a client must echo the CSRF cookie value into for mutating requests. */
export const CSRF_HEADER_NAME = "x-csrf-token";

/** Session lifetime. Sessions are absolute-expiry; there is no silent extension. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/** Verification / password-reset token lifetime. */
export const VERIFICATION_TTL_SECONDS = 60 * 60; // 1 hour

/** Bytes of entropy for session and verification tokens. */
export const TOKEN_BYTES = 32;

/**
 * Argon2id parameters. Defaults follow the OWASP Password Storage Cheat Sheet
 * (m=19456 KiB, t=2, p=1). Tunable via env for stronger production hardware
 * without a code change.
 */
export const ARGON2_OPTIONS = {
  memoryCost: serverEnv.AUTH_ARGON_MEMORY_KIB,
  timeCost: serverEnv.AUTH_ARGON_TIME_COST,
  parallelism: serverEnv.AUTH_ARGON_PARALLELISM,
} as const;

export function isProduction(): boolean {
  return serverEnv.NODE_ENV === "production";
}

/** Cookie attributes shared by the session and CSRF cookies. */
export function baseCookieOptions() {
  return {
    path: "/",
    sameSite: "lax" as const,
    secure: isProduction(),
  };
}
