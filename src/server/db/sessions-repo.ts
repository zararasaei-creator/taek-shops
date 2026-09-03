import type { PrismaClient } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { safeUserSelect, type SafeUser } from "@/server/db/users-repo";

/**
 * Session persistence. Only the SHA-256 (optionally HMAC-peppered) hash of a
 * session token is ever stored; the raw token lives only in the user's cookie.
 */

type Db = Pick<PrismaClient, "session">;

export interface SessionWithUser {
  id: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
  user: SafeUser;
}

export async function createSession(
  input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
  db: Db = prisma,
): Promise<{ id: string }> {
  const session = await db.session.create({
    data: {
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
    select: { id: true },
  });
  return session;
}

export async function findSessionByTokenHash(
  tokenHash: string,
  db: Db = prisma,
): Promise<SessionWithUser | null> {
  return db.session.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      createdAt: true,
      user: { select: safeUserSelect },
    },
  });
}

export async function deleteSessionByTokenHash(tokenHash: string, db: Db = prisma): Promise<void> {
  await db.session.deleteMany({ where: { tokenHash } });
}

export async function deleteSessionById(id: string, db: Db = prisma): Promise<void> {
  await db.session.deleteMany({ where: { id } });
}

/** Revoke every session for a user (e.g. after a password reset). */
export async function deleteSessionsForUser(userId: string, db: Db = prisma): Promise<number> {
  const { count } = await db.session.deleteMany({ where: { userId } });
  return count;
}

/** Housekeeping: drop expired rows. Safe to call opportunistically. */
export async function deleteExpiredSessions(
  now: Date = new Date(),
  db: Db = prisma,
): Promise<number> {
  const { count } = await db.session.deleteMany({ where: { expiresAt: { lt: now } } });
  return count;
}
