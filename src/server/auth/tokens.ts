import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { serverEnv } from "@/server/config/env";
import { TOKEN_BYTES } from "@/server/auth/config";

/**
 * Opaque token generation and hashing for sessions and verification links.
 *
 * - The raw token is high-entropy random bytes, URL-safe base64.
 * - Only its hash is persisted. If `AUTH_SECRET` is set the hash is an HMAC
 *   (keyed), so a database dump alone yields nothing usable; otherwise it is a
 *   plain SHA-256.
 */

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashToken(rawToken: string): string {
  const secret = serverEnv.AUTH_SECRET;
  if (secret) {
    return createHmac("sha256", secret).update(rawToken).digest("hex");
  }
  return createHash("sha256").update(rawToken).digest("hex");
}

/** Constant-time comparison of two hex digests of equal length. */
export function safeEqualHex(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "hex");
  const bufferB = Buffer.from(b, "hex");
  if (bufferA.length !== bufferB.length || bufferA.length === 0) return false;
  return timingSafeEqual(bufferA, bufferB);
}
