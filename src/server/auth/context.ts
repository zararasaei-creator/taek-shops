import { cache } from "react";

import type { SafeUser } from "@/server/db/users-repo";
import { readSessionCookie } from "@/server/auth/cookies";
import { validateSessionToken } from "@/server/auth/session";
import {
  requireRole as requireRoleGuard,
  requireUser as requireUserGuard,
} from "@/server/auth/authorization";
import { AccountDisabledError } from "@/server/auth/errors";
import type { UserRole } from "@prisma/client";

/**
 * Request-scoped current-user resolution for Server Components, Route Handlers,
 * and Server Actions. `cache()` dedupes the cookie read + DB lookup within a
 * single request.
 */

export interface AuthContext {
  user: SafeUser;
  session: { id: string; expiresAt: Date };
}

export const getAuthContext = cache(async (): Promise<AuthContext | null> => {
  const rawToken = await readSessionCookie();
  const validation = await validateSessionToken(rawToken);
  if (validation.status !== "active") return null;
  return { user: validation.user, session: validation.session };
});

export async function getCurrentUser(): Promise<SafeUser | null> {
  return (await getAuthContext())?.user ?? null;
}

/** Throws `UnauthenticatedError` when there is no active session. */
export async function requireAuth(): Promise<AuthContext> {
  const context = await getAuthContext();
  requireUserGuard(context?.user ?? null);
  return context as AuthContext;
}

/** Throws `UnauthenticatedError` / `ForbiddenError` unless the user is >= `role`. */
export async function requireRole(role: UserRole): Promise<AuthContext> {
  const context = await requireAuth();
  requireRoleGuard(context.user, role);
  return context;
}

/**
 * Distinguish "no session" from "session belongs to a disabled account" — useful
 * for showing an explanatory page rather than a plain login redirect.
 */
export async function assertNotDisabled(): Promise<void> {
  const rawToken = await readSessionCookie();
  const validation = await validateSessionToken(rawToken);
  if (validation.status === "disabled") {
    throw new AccountDisabledError(`user ${validation.user.id} is ${validation.user.status}`);
  }
}
