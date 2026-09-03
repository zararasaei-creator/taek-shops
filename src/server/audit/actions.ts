/**
 * Audit action constants. Dotted `domain.subject.event` strings, stored as plain
 * text in `AuditLog.action` (not a DB enum) so new business events can be added
 * without a migration. Keep this list the single source of truth.
 */
export const AUDIT_ACTIONS = {
  LOGIN_SUCCEEDED: "auth.login.succeeded",
  LOGIN_FAILED: "auth.login.failed",
  LOGOUT: "auth.logout",
  SESSION_REVOKED: "auth.session.revoked",
  PASSWORD_CHANGED: "auth.password.changed",
  PASSWORD_RESET_REQUESTED: "auth.password.reset_requested",
  PASSWORD_RESET_COMPLETED: "auth.password.reset_completed",
  EMAIL_VERIFICATION_REQUESTED: "auth.email.verification_requested",
  EMAIL_VERIFIED: "auth.email.verified",
  USER_CREATED: "user.created",
  USER_ROLE_CHANGED: "user.role.changed",
  USER_STATUS_CHANGED: "user.status.changed",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
