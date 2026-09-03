import { UserStatus, type PrismaClient } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { recordAudit } from "@/server/audit/audit-service";
import { AUDIT_ACTIONS } from "@/server/audit/actions";
import { findCredentialsByEmail, type SafeUser } from "@/server/db/users-repo";
import { InvalidCredentialsError, RateLimitedError } from "@/server/auth/errors";
import { verifyPassword } from "@/server/auth/password";
import {
  enforceRateLimit,
  rateLimiter as defaultRateLimiter,
  type RateLimiter,
} from "@/server/auth/rate-limit";
import {
  issueSession,
  revokeSessionToken,
  validateSessionToken,
  type SessionMeta,
} from "@/server/auth/session";
import { clearSessionCookie, readSessionCookie, writeSessionCookie } from "@/server/auth/cookies";

/**
 * Credentials authentication.
 *
 * `authenticateWithCredentials` is the provider seam — a future
 * `authenticateWithOAuth(...)` would sit beside it and feed the same
 * `issueSession` path. It is framework-agnostic and fully unit-testable.
 * `login` / `logout` add the Next.js cookie + request-context wiring.
 */

// A real Argon2id hash (of a random throwaway string) with current-policy
// params. Verifying against it for unknown users keeps failed-login timing
// independent of whether the account exists.
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$iNxVDgrFUNHTBL3qCf1nPg$GTHc6g8aPJuKZAf0Yor/vrax60Jh3nUC1JKK4f/Ffh8";

export interface CredentialsInput {
  email: string;
  password: string;
  meta?: SessionMeta;
}

export interface AuthDeps {
  db?: Pick<PrismaClient, "user" | "session" | "auditLog">;
  limiter?: RateLimiter;
}

export async function authenticateWithCredentials(
  input: CredentialsInput,
  deps: AuthDeps = {},
): Promise<SafeUser> {
  const db = deps.db ?? prisma;
  const limiter = deps.limiter ?? defaultRateLimiter;
  const email = input.email.trim().toLowerCase();
  const ip = input.meta?.ipAddress ?? "unknown";

  for (const key of [`email:${email}`, `ip:${ip}`]) {
    const result = await enforceRateLimit("login", key, limiter);
    if (!result.allowed) {
      await recordAudit(
        {
          action: AUDIT_ACTIONS.LOGIN_FAILED,
          metadata: { email, reason: "rate_limited" },
          ipAddress: input.meta?.ipAddress,
          userAgent: input.meta?.userAgent,
        },
        db,
      );
      throw new RateLimitedError(result.retryAfterSeconds);
    }
  }

  const account = await findCredentialsByEmail(email, db);
  const passwordOk = await verifyPassword(account?.passwordHash ?? DUMMY_HASH, input.password);

  if (!account || !passwordOk) {
    await recordAudit(
      {
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        actorUserId: account?.id ?? null,
        metadata: { email, reason: account ? "bad_password" : "unknown_user" },
        ipAddress: input.meta?.ipAddress,
        userAgent: input.meta?.userAgent,
      },
      db,
    );
    throw new InvalidCredentialsError();
  }

  if (account.status !== UserStatus.ACTIVE) {
    await recordAudit(
      {
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        actorUserId: account.id,
        metadata: { email, reason: "account_disabled", status: account.status },
        ipAddress: input.meta?.ipAddress,
        userAgent: input.meta?.userAgent,
      },
      db,
    );
    // Generic error — do not disclose that the account exists but is disabled.
    throw new InvalidCredentialsError("account disabled");
  }

  const { passwordHash: _passwordHash, ...safeUser } = account;
  await recordAudit(
    {
      action: AUDIT_ACTIONS.LOGIN_SUCCEEDED,
      actorUserId: safeUser.id,
      entityType: "User",
      entityId: safeUser.id,
      ipAddress: input.meta?.ipAddress,
      userAgent: input.meta?.userAgent,
    },
    db,
  );
  return safeUser;
}

/** Full sign-in: authenticate, create a DB session, set the cookie. */
export async function login(input: CredentialsInput): Promise<{ user: SafeUser }> {
  const user = await authenticateWithCredentials(input);
  const issued = await issueSession(user.id, input.meta ?? {});
  await writeSessionCookie(issued.rawToken, issued.expiresAt);
  return { user };
}

/** Full sign-out: revoke the current session and clear the cookie. */
export async function logout(meta?: SessionMeta): Promise<void> {
  const rawToken = await readSessionCookie();
  let actorUserId: string | null = null;
  if (rawToken) {
    const validation = await validateSessionToken(rawToken);
    if (validation.status === "active" || validation.status === "disabled") {
      actorUserId = validation.user.id;
    }
    await revokeSessionToken(rawToken);
  }
  await clearSessionCookie();
  await recordAudit({
    action: AUDIT_ACTIONS.LOGOUT,
    actorUserId,
    ipAddress: meta?.ipAddress,
    userAgent: meta?.userAgent,
  });
}
