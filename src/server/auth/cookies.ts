import { cookies } from "next/headers";

import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  baseCookieOptions,
} from "@/server/auth/config";
import { generateToken } from "@/server/auth/tokens";

/**
 * Next.js cookie glue for auth. Kept separate from the framework-agnostic
 * session logic so the latter stays unit-testable without a request context.
 *
 * - Session cookie: httpOnly, SameSite=Lax, Secure in production, Path=/.
 * - CSRF cookie: readable by scripts (not httpOnly) for the double-submit pattern.
 */

export async function readSessionCookie(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE_NAME)?.value;
}

export async function writeSessionCookie(rawToken: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(SESSION_COOKIE_NAME, rawToken, {
    ...baseCookieOptions(),
    httpOnly: true,
    expires: expiresAt,
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).set(SESSION_COOKIE_NAME, "", {
    ...baseCookieOptions(),
    httpOnly: true,
    maxAge: 0,
  });
}

export async function readCsrfCookie(): Promise<string | undefined> {
  return (await cookies()).get(CSRF_COOKIE_NAME)?.value;
}

/** Ensure a CSRF cookie exists; returns the current token value. */
export async function ensureCsrfCookie(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(CSRF_COOKIE_NAME)?.value;
  if (existing) return existing;

  const token = generateToken();
  jar.set(CSRF_COOKIE_NAME, token, {
    ...baseCookieOptions(),
    httpOnly: false,
    maxAge: SESSION_TTL_SECONDS,
  });
  return token;
}
