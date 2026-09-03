import { UserRole } from "@prisma/client";

import {
  ForbiddenError,
  PrivilegeEscalationError,
  UnauthenticatedError,
} from "@/server/auth/errors";

/**
 * Role-based access control.
 *
 * `UserRole` is an ordered hierarchy. `requireRole` is "this role or higher";
 * `requireAnyRole` is exact membership. Fine-grained `Permission`s are layered on
 * top via `ROLE_PERMISSIONS` so individual capabilities can later be granted
 * without reshuffling the hierarchy.
 */

export const ROLE_RANK: Record<UserRole, number> = {
  [UserRole.CUSTOMER]: 100,
  [UserRole.STAFF]: 200,
  [UserRole.MANAGER]: 300,
  [UserRole.ADMIN]: 400,
};

/** Minimal shape the authorization layer needs from a user. */
export interface AuthUser {
  id: string;
  role: UserRole;
}

export type Permission =
  | "audit.read"
  | "user.read"
  | "user.role.write"
  | "user.status.write"
  | "catalog.read"
  | "catalog.write"
  | "inventory.read"
  | "inventory.write"
  | "order.read"
  | "order.write"
  | "import.run"
  | "settings.write";

/**
 * Capability grants per role. A role also inherits every permission of the roles
 * below it (resolved in `permissionsForRole`).
 */
const DIRECT_PERMISSIONS: Record<UserRole, Permission[]> = {
  [UserRole.CUSTOMER]: [],
  [UserRole.STAFF]: ["catalog.read", "inventory.read", "order.read"],
  [UserRole.MANAGER]: [
    "catalog.write",
    "inventory.write",
    "order.write",
    "import.run",
    "user.read",
  ],
  [UserRole.ADMIN]: ["audit.read", "user.role.write", "user.status.write", "settings.write"],
};

const ROLES_LOW_TO_HIGH: UserRole[] = [
  UserRole.CUSTOMER,
  UserRole.STAFF,
  UserRole.MANAGER,
  UserRole.ADMIN,
];

export function permissionsForRole(role: UserRole): Set<Permission> {
  const result = new Set<Permission>();
  for (const current of ROLES_LOW_TO_HIGH) {
    for (const permission of DIRECT_PERMISSIONS[current]) result.add(permission);
    if (current === role) break;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Predicates (never throw)
// ---------------------------------------------------------------------------

export function hasRole(user: AuthUser | null | undefined, minimum: UserRole): boolean {
  if (!user) return false;
  return ROLE_RANK[user.role] >= ROLE_RANK[minimum];
}

export function hasAnyRole(user: AuthUser | null | undefined, roles: readonly UserRole[]): boolean {
  if (!user) return false;
  return roles.includes(user.role);
}

export function hasPermission(user: AuthUser | null | undefined, permission: Permission): boolean {
  if (!user) return false;
  return permissionsForRole(user.role).has(permission);
}

export function isAdmin(user: AuthUser | null | undefined): boolean {
  return hasAnyRole(user, [UserRole.ADMIN]);
}

export function isManager(user: AuthUser | null | undefined): boolean {
  return hasRole(user, UserRole.MANAGER);
}

export function isStaff(user: AuthUser | null | undefined): boolean {
  return hasRole(user, UserRole.STAFF);
}

// ---------------------------------------------------------------------------
// Guards (throw typed errors; use in services and route handlers)
// ---------------------------------------------------------------------------

export function requireUser<T extends AuthUser>(user: T | null | undefined): T {
  if (!user) throw new UnauthenticatedError();
  return user;
}

export function requireRole<T extends AuthUser>(user: T | null | undefined, minimum: UserRole): T {
  const authed = requireUser(user);
  if (!hasRole(authed, minimum)) {
    throw new ForbiddenError(`requires ${minimum}; actor is ${authed.role}`);
  }
  return authed;
}

export function requireAnyRole<T extends AuthUser>(
  user: T | null | undefined,
  roles: readonly UserRole[],
): T {
  const authed = requireUser(user);
  if (!hasAnyRole(authed, roles)) {
    throw new ForbiddenError(`requires one of [${roles.join(", ")}]; actor is ${authed.role}`);
  }
  return authed;
}

export function requirePermission<T extends AuthUser>(
  user: T | null | undefined,
  permission: Permission,
): T {
  const authed = requireUser(user);
  if (!hasPermission(authed, permission)) {
    throw new ForbiddenError(`missing permission ${permission}; actor is ${authed.role}`);
  }
  return authed;
}

// ---------------------------------------------------------------------------
// Privilege-escalation rule for role assignment
// ---------------------------------------------------------------------------

/**
 * ADMIN may assign any role (including ADMIN, so admins can appoint admins).
 * Anyone else may assign only roles strictly below their own rank — so a
 * MANAGER could never mint a MANAGER or an ADMIN even if a future policy change
 * granted them `user.role.write`.
 */
export function canAssignRole(actorRole: UserRole, targetRole: UserRole): boolean {
  if (actorRole === UserRole.ADMIN) return true;
  return ROLE_RANK[targetRole] < ROLE_RANK[actorRole];
}

export function assertCanAssignRole(actor: AuthUser, targetRole: UserRole): void {
  if (!canAssignRole(actor.role, targetRole)) {
    throw new PrivilegeEscalationError(`${actor.role} attempted to assign ${targetRole}`);
  }
}
