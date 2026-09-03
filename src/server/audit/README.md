# Audit logging (`src/server/audit`)

Generic, append-only audit trail (`AuditLog` model). Introduced in Phase 3;
designed to carry business events too.

| File               | Responsibility                                                 |
| ------------------ | -------------------------------------------------------------- |
| `actions.ts`       | `AUDIT_ACTIONS` constants (dotted strings, not a DB enum)      |
| `sanitize.ts`      | Redacts sensitive keys, caps depth/size, guarantees plain JSON |
| `audit-service.ts` | `recordAudit(input, db?)` — sanitises, writes, never rethrows  |

## Guarantees

- Metadata is **always** sanitised: any key matching
  `pass*/secret/token/hash/credential/authorization/cookie/…` is redacted.
- Plaintext passwords, password hashes, reset-token secrets, and session
  secrets are never passed to `recordAudit` by callers, and would be redacted
  if they were.
- A failed audit write is logged to stderr but does **not** fail the operation
  being audited.

## Events emitted in Phase 3

`auth.login.succeeded`, `auth.login.failed`, `auth.logout`,
`auth.password.changed`, `auth.password.reset_requested`,
`auth.password.reset_completed`, `auth.email.verification_requested`,
`auth.email.verified`, `user.created`, `user.role.changed`,
`user.status.changed`.
