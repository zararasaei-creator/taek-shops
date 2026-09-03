import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";

import { ARGON2_OPTIONS } from "@/server/auth/config";
import { WeakPasswordError } from "@/server/auth/errors";
import { validatePassword, type PasswordContext } from "@/server/auth/password-policy";

/**
 * Password hashing (Argon2id).
 *
 * - Plaintext passwords are never stored, logged, or returned.
 * - Hashes are PHC strings (`$argon2id$v=19$m=...`), self-describing so cost
 *   parameters can be raised later without breaking existing users.
 * - Verification is constant-time (handled by the argon2 implementation).
 */

// `@node-rs/argon2` defaults `algorithm` to Argon2id, so it is left unset (its
// `Algorithm` const enum cannot be referenced under `isolatedModules`).
const argonOptions = {
  memoryCost: ARGON2_OPTIONS.memoryCost,
  timeCost: ARGON2_OPTIONS.timeCost,
  parallelism: ARGON2_OPTIONS.parallelism,
} as const;

/** Hash a new password after enforcing the password policy. */
export async function hashPassword(password: string, context?: PasswordContext): Promise<string> {
  const reasons = validatePassword(password, context);
  if (reasons.length > 0) {
    throw new WeakPasswordError(reasons);
  }
  return argon2Hash(password, argonOptions);
}

/**
 * Verify a candidate password against a stored hash. Returns `false` (never
 * throws) for a wrong password or an unparseable/absent hash, so callers cannot
 * accidentally leak the difference.
 */
export async function verifyPassword(
  storedHash: string | null | undefined,
  candidate: string,
): Promise<boolean> {
  if (!storedHash) return false;
  try {
    return await argon2Verify(storedHash, candidate);
  } catch {
    return false;
  }
}

/** Whether a stored hash was produced with weaker parameters than current policy. */
export function needsRehash(storedHash: string): boolean {
  const match = /\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)/.exec(storedHash);
  if (!match) return true;
  const [, memory, time, parallelism] = match;
  return (
    Number(memory) < argonOptions.memoryCost ||
    Number(time) < argonOptions.timeCost ||
    Number(parallelism) < argonOptions.parallelism
  );
}
