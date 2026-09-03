import { UserStatus, type PrismaClient } from "@prisma/client";

import { prisma } from "@/server/db/client";
import {
  createSession,
  deleteSessionByTokenHash,
  deleteSessionsForUser,
  findSessionByTokenHash,
  type SessionWithUser,
} from "@/server/db/sessions-repo";
import { recordSuccessfulLogin } from "@/server/db/users-repo";
import { SESSION_TTL_SECONDS } from "@/server/auth/config";
import { generateToken, hashToken } from "@/server/auth/tokens";
import type { SafeUser } from "@/server/db/users-repo";

/**
 * Database-backed session lifecycle. All authorization data (role, status) is
 * read fresh from the DB on every validation — the cookie carries only an opaque
 * token, never identity or privilege claims.
 */

type Db = Pick<PrismaClient, "session" | "user">;

export interface IssuedSession {
  rawToken: string;
  sessionId: string;
  expiresAt: Date;
}

export interface SessionMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export type SessionValidation =
  | { status: "active"; session: { id: string; expiresAt: Date }; user: SafeUser }
  | { status: "invalid" }
  | { status: "expired" }
  | { status: "disabled"; user: SafeUser };

export async function issueSession(
  userId: string,
  meta: SessionMeta = {},
  db: Db = prisma,
): Promise<IssuedSession> {
  const rawToken = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  const { id } = await createSession(
    { userId, tokenHash: hashToken(rawToken), expiresAt, ...meta },
    db,
  );
  await recordSuccessfulLogin(userId, db).catch(() => {
    /* lastLoginAt is best-effort telemetry, not correctness */
  });
  return { rawToken, sessionId: id, expiresAt };
}

export async function validateSessionToken(
  rawToken: string | undefined | null,
  db: Db = prisma,
): Promise<SessionValidation> {
  if (!rawToken) return { status: "invalid" };

  const record: SessionWithUser | null = await findSessionByTokenHash(hashToken(rawToken), db);
  if (!record) return { status: "invalid" };

  if (record.expiresAt.getTime() <= Date.now()) {
    await deleteSessionByTokenHash(hashToken(rawToken), db).catch(() => {});
    return { status: "expired" };
  }

  if (record.user.status !== UserStatus.ACTIVE) {
    return { status: "disabled", user: record.user };
  }

  return {
    status: "active",
    session: { id: record.id, expiresAt: record.expiresAt },
    user: record.user,
  };
}

export async function revokeSessionToken(
  rawToken: string | undefined | null,
  db: Db = prisma,
): Promise<void> {
  if (!rawToken) return;
  await deleteSessionByTokenHash(hashToken(rawToken), db);
}

export async function revokeAllSessionsForUser(userId: string, db: Db = prisma): Promise<number> {
  return deleteSessionsForUser(userId, db);
}
