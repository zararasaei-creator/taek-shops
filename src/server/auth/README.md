# Authentication & authorization (`src/server/auth`)

Custom, framework-agnostic credentials auth with **database-backed sessions**.
Auth.js-compatible in shape (provider seam, session concept, callbacks-style
flow) but not the NextAuth library — see `docs/security.md` § "Why not NextAuth".

## Modules

| File                 | Responsibility                                                         |
| -------------------- | ---------------------------------------------------------------------- |
| `config.ts`          | Cookie names, TTLs, Argon2 params, cookie option helper                |
| `errors.ts`          | Typed `AuthError`s (code + HTTP status + safe public message)          |
| `password-policy.ts` | The single source of password rules (length, blocklist, personal info) |
| `password.ts`        | Argon2id hash / verify / needs-rehash                                  |
| `tokens.ts`          | Opaque token generation + (optionally peppered) hashing                |
| `session.ts`         | Issue / validate / revoke DB sessions (no cookie access)               |
| `cookies.ts`         | Next.js cookie glue for the session + CSRF cookies                     |
| `authentication.ts`  | `authenticateWithCredentials` (seam) + `login` / `logout`              |
| `authorization.ts`   | Role hierarchy, permissions, `requireUser/Role/AnyRole/Permission`     |
| `context.ts`         | `getAuthContext` / `getCurrentUser` / `requireAuth` / `requireRole`    |
| `verification.ts`    | Password-reset + email-verification foundations, self-service change   |
| `rate-limit.ts`      | `RateLimiter` interface + in-process implementation                    |
| `mailer.ts`          | `Mailer` interface + `NoopMailer` (no delivery in Phase 3)             |
| `index.ts`           | Public barrel — import from `@/server/auth`                            |

## Rules of the road

- All authorization data (role, status) is read from the DB on every request.
  The cookie holds only an opaque token.
- `passwordHash` is read by exactly one repo function and never leaves the server.
- Guards throw typed errors; route handlers map them via
  `src/lib/http/api-response.ts`.
- The proxy (`src/proxy.ts`) gate is optimistic UX only — never the authority.
