/**
 * Public auth surface. Import from `@/server/auth` rather than reaching into
 * individual files.
 */
export {
  getAuthContext,
  getCurrentUser,
  requireAuth,
  requireRole,
  assertNotDisabled,
  type AuthContext,
} from "@/server/auth/context";

export {
  authenticateWithCredentials,
  login,
  logout,
  type CredentialsInput,
} from "@/server/auth/authentication";

export {
  ROLE_RANK,
  permissionsForRole,
  hasRole,
  hasAnyRole,
  hasPermission,
  isAdmin,
  isManager,
  isStaff,
  requireUser,
  requireRole as requireRoleGuard,
  requireAnyRole,
  requirePermission,
  type AuthUser,
  type Permission,
} from "@/server/auth/authorization";

export {
  validateSessionToken,
  issueSession,
  revokeSessionToken,
  revokeAllSessionsForUser,
} from "@/server/auth/session";

export {
  requestPasswordReset,
  completePasswordReset,
  requestEmailVerification,
  confirmEmailVerification,
  changeOwnPassword,
} from "@/server/auth/verification";

export {
  registerCustomer,
  resendVerificationForUser,
  type RegistrationInput,
} from "@/server/auth/registration";

export * from "@/server/auth/errors";
