import { UserRole, UserStatus, type PrismaClient } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { recordAudit } from "@/server/audit/audit-service";
import { AUDIT_ACTIONS } from "@/server/audit/actions";
import {
  createUser,
  findUserById,
  listUsers as listUsersRepo,
  setUserRole,
  setUserStatus,
  type ListUsersOptions,
  type SafeUser,
} from "@/server/db/users-repo";
import { revokeAllSessionsForUser } from "@/server/auth/session";
import { assertCanAssignRole, requirePermission, type AuthUser } from "@/server/auth/authorization";
import { ForbiddenError, SelfRoleChangeError } from "@/server/auth/errors";
import { hashPassword } from "@/server/auth/password";

/**
 * Internal user management. Every function takes the acting user (which may be
 * `null` for an unauthenticated caller) and enforces authorization server-side.
 * Privilege-escalation and self-modification rules live here, not in transport.
 */

type Db = Pick<PrismaClient, "user" | "session" | "auditLog">;
type Actor = AuthUser | null | undefined;

interface ActionMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export class UserNotFoundError extends ForbiddenError {
  constructor() {
    super("target user not found");
  }
}

export async function listUsers(
  actor: Actor,
  options: ListUsersOptions = {},
  db: Db = prisma,
): Promise<{ users: SafeUser[]; total: number }> {
  requirePermission(actor, "user.read");
  return listUsersRepo(options, db);
}

export async function getUser(actor: Actor, userId: string, db: Db = prisma): Promise<SafeUser> {
  requirePermission(actor, "user.read");
  const user = await findUserById(userId, db);
  if (!user) throw new UserNotFoundError();
  return user;
}

/**
 * Rules:
 * - actor needs `user.role.write` (ADMIN by default policy);
 * - nobody changes their own role;
 * - a non-admin actor may not grant a role at or above their own rank
 *   (defence-in-depth even though only ADMIN currently holds the permission).
 */
export async function changeUserRole(
  actor: Actor,
  input: { userId: string; role: UserRole } & ActionMeta,
  db: Db = prisma,
): Promise<SafeUser> {
  const authed = requirePermission(actor, "user.role.write");

  if (input.userId === authed.id) throw new SelfRoleChangeError();
  assertCanAssignRole(authed, input.role);

  const target = await findUserById(input.userId, db);
  if (!target) throw new UserNotFoundError();
  if (target.role === input.role) return target;

  const updated = await setUserRole(input.userId, input.role, db);
  await recordAudit(
    {
      action: AUDIT_ACTIONS.USER_ROLE_CHANGED,
      actorUserId: authed.id,
      entityType: "User",
      entityId: target.id,
      metadata: { previousRole: target.role, newRole: input.role },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
    db,
  );
  return updated;
}

/**
 * Activate / deactivate (or otherwise set status). Disabling a user immediately
 * revokes their sessions; `validateSessionToken` also rejects them on the next
 * request regardless.
 */
export async function setAccountStatus(
  actor: Actor,
  input: { userId: string; status: UserStatus } & ActionMeta,
  db: Db = prisma,
): Promise<SafeUser> {
  const authed = requirePermission(actor, "user.status.write");

  if (input.userId === authed.id) {
    throw new ForbiddenError("you cannot change your own account status");
  }

  const target = await findUserById(input.userId, db);
  if (!target) throw new UserNotFoundError();
  if (target.status === input.status) return target;

  const updated = await setUserStatus(input.userId, input.status, db);

  let sessionsRevoked = 0;
  if (input.status !== UserStatus.ACTIVE) {
    sessionsRevoked = await revokeAllSessionsForUser(input.userId, db);
  }

  await recordAudit(
    {
      action: AUDIT_ACTIONS.USER_STATUS_CHANGED,
      actorUserId: authed.id,
      entityType: "User",
      entityId: target.id,
      metadata: { previousStatus: target.status, newStatus: input.status, sessionsRevoked },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
    db,
  );
  return updated;
}

/** ADMIN-only creation of an internal user. New users start `INVITED`. */
export async function adminCreateUser(
  actor: Actor,
  input: {
    email: string;
    role: UserRole;
    firstName?: string;
    lastName?: string;
    temporaryPassword?: string;
  } & ActionMeta,
  db: Db = prisma,
): Promise<SafeUser> {
  const authed = requirePermission(actor, "user.role.write");
  assertCanAssignRole(authed, input.role);

  const passwordHash = input.temporaryPassword
    ? await hashPassword(input.temporaryPassword, { email: input.email })
    : null;

  const user = await createUser(
    {
      email: input.email,
      role: input.role,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      passwordHash,
      status: UserStatus.INVITED,
    },
    db,
  );

  await recordAudit(
    {
      action: AUDIT_ACTIONS.USER_CREATED,
      actorUserId: authed.id,
      entityType: "User",
      entityId: user.id,
      metadata: { role: input.role, status: user.status },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
    db,
  );
  return user;
}
