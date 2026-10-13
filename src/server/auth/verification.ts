import { VerificationPurpose, type PrismaClient } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { recordAudit } from "@/server/audit/audit-service";
import { AUDIT_ACTIONS } from "@/server/audit/actions";
import {
  findCredentialsById,
  findUserByEmail,
  markEmailVerified,
  normalizeEmail,
  setUserPasswordHash,
} from "@/server/db/users-repo";
import { VERIFICATION_TTL_SECONDS } from "@/server/auth/config";
import {
  InvalidCredentialsError,
  InvalidTokenError,
  RateLimitedError,
  WeakPasswordError,
} from "@/server/auth/errors";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { validatePassword } from "@/server/auth/password-policy";
import {
  enforceRateLimit,
  rateLimiter as defaultLimiter,
  type RateLimiter,
} from "@/server/auth/rate-limit";
import { revokeAllSessionsForUser } from "@/server/auth/session";
import { generateToken, hashToken } from "@/server/auth/tokens";
import { getMailer, type Mailer } from "@/server/auth/mailer";

/**
 * Password-reset and email-verification foundations, built on the Phase 2
 * `VerificationToken` model. Token secrets are never logged or returned to
 * clients — they go only to the `Mailer`.
 */

type Db = Pick<PrismaClient, "user" | "verificationToken" | "session" | "auditLog">;

export interface VerificationDeps {
  db?: Db;
  mailer?: Mailer;
  limiter?: RateLimiter;
}

interface AuditMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Create a single-use token, invalidating any prior unconsumed one. */
export async function createVerificationToken(
  identifier: string,
  purpose: VerificationPurpose,
  db: Db = prisma,
): Promise<string> {
  const normalized = normalizeEmail(identifier);
  await db.verificationToken.deleteMany({
    where: { identifier: normalized, purpose, consumedAt: null },
  });

  const rawToken = generateToken();
  await db.verificationToken.create({
    data: {
      identifier: normalized,
      purpose,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + VERIFICATION_TTL_SECONDS * 1000),
    },
  });
  return rawToken;
}

/** Validate + single-use consume. Throws `InvalidTokenError` on any problem. */
export async function consumeVerificationToken(
  rawToken: string,
  purpose: VerificationPurpose,
  db: Db = prisma,
): Promise<string> {
  const record = await db.verificationToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
  });
  if (
    !record ||
    record.purpose !== purpose ||
    record.consumedAt !== null ||
    record.expiresAt.getTime() <= Date.now()
  ) {
    throw new InvalidTokenError();
  }
  await db.verificationToken.update({
    where: { id: record.id },
    data: { consumedAt: new Date() },
  });
  return record.identifier;
}

/**
 * Always resolves the same way whether or not the email maps to a user, so it
 * cannot be used to enumerate accounts.
 */
export async function requestPasswordReset(
  input: { email: string } & AuditMeta,
  deps: VerificationDeps = {},
): Promise<void> {
  const db = deps.db ?? prisma;
  const limiter = deps.limiter ?? defaultLimiter;
  const mailer = deps.mailer ?? getMailer();
  const email = normalizeEmail(input.email);

  for (const key of [`email:${email}`, `ip:${input.ipAddress ?? "unknown"}`]) {
    const result = await enforceRateLimit("passwordResetRequest", key, limiter);
    if (!result.allowed) throw new RateLimitedError(result.retryAfterSeconds);
  }

  const user = await findUserByEmail(email, db);
  await recordAudit(
    {
      action: AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED,
      actorUserId: user?.id ?? null,
      metadata: { email, userFound: Boolean(user) },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
    db,
  );

  if (!user) return;
  const token = await createVerificationToken(email, VerificationPurpose.PASSWORD_RESET, db);
  await mailer.sendPasswordReset({ to: email, token });
}

export async function completePasswordReset(
  input: { token: string; password: string } & AuditMeta,
  deps: VerificationDeps = {},
): Promise<void> {
  const db = deps.db ?? prisma;
  const identifier = await consumeVerificationToken(
    input.token,
    VerificationPurpose.PASSWORD_RESET,
    db,
  );

  const user = await findUserByEmail(identifier, db);
  if (!user) throw new InvalidTokenError("token identifier no longer maps to a user");

  const reasons = validatePassword(input.password, { email: user.email });
  if (reasons.length > 0) throw new WeakPasswordError(reasons);

  const passwordHash = await hashPassword(input.password, { email: user.email });
  await setUserPasswordHash(user.id, passwordHash, db);
  const revoked = await revokeAllSessionsForUser(user.id, db);

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PASSWORD_RESET_COMPLETED,
      actorUserId: user.id,
      entityType: "User",
      entityId: user.id,
      metadata: { sessionsRevoked: revoked },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
    db,
  );
}

export async function requestEmailVerification(
  input: { email: string } & AuditMeta,
  deps: VerificationDeps = {},
): Promise<void> {
  const db = deps.db ?? prisma;
  const limiter = deps.limiter ?? defaultLimiter;
  const mailer = deps.mailer ?? getMailer();
  const email = normalizeEmail(input.email);

  for (const key of [`email:${email}`, `ip:${input.ipAddress ?? "unknown"}`]) {
    const result = await enforceRateLimit("verificationRequest", key, limiter);
    if (!result.allowed) throw new RateLimitedError(result.retryAfterSeconds);
  }

  const user = await findUserByEmail(email, db);
  await recordAudit(
    {
      action: AUDIT_ACTIONS.EMAIL_VERIFICATION_REQUESTED,
      actorUserId: user?.id ?? null,
      metadata: { email, userFound: Boolean(user) },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
    db,
  );

  if (!user || user.emailVerifiedAt) return;
  const token = await createVerificationToken(email, VerificationPurpose.EMAIL_VERIFICATION, db);
  await mailer.sendEmailVerification({ to: email, token });
}

export async function confirmEmailVerification(
  input: { token: string } & AuditMeta,
  deps: VerificationDeps = {},
): Promise<void> {
  const db = deps.db ?? prisma;
  const identifier = await consumeVerificationToken(
    input.token,
    VerificationPurpose.EMAIL_VERIFICATION,
    db,
  );
  const user = await findUserByEmail(identifier, db);
  if (!user) throw new InvalidTokenError("token identifier no longer maps to a user");

  await markEmailVerified(user.id, db);
  await recordAudit(
    {
      action: AUDIT_ACTIONS.EMAIL_VERIFIED,
      actorUserId: user.id,
      entityType: "User",
      entityId: user.id,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
    db,
  );
}

/** Authenticated self-service password change. Keeps the caller's own session. */
export async function changeOwnPassword(
  input: { userId: string; currentPassword: string; newPassword: string } & AuditMeta,
  deps: VerificationDeps = {},
): Promise<void> {
  const db = deps.db ?? prisma;
  const account = await findCredentialsById(input.userId, db);
  if (!account) throw new InvalidCredentialsError();

  const currentOk = await verifyPassword(account.passwordHash, input.currentPassword);
  if (!currentOk) throw new InvalidCredentialsError("current password mismatch");

  const context = {
    email: account.email,
    firstName: account.firstName,
    lastName: account.lastName,
  };
  const reasons = validatePassword(input.newPassword, context);
  if (reasons.length > 0) throw new WeakPasswordError(reasons);

  const passwordHash = await hashPassword(input.newPassword, context);
  await setUserPasswordHash(account.id, passwordHash, db);

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PASSWORD_CHANGED,
      actorUserId: account.id,
      entityType: "User",
      entityId: account.id,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
    db,
  );
}
