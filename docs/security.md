# Taek Shops — Security Notes

> Status: **Phase 3 (authentication, authorization, audit) implemented.**
> Consolidated record of security decisions and deferrals. See
> `docs/architecture.md` for the surrounding design.

## 1. Authentication architecture

- **Custom credentials auth with database-backed sessions**, framework-agnostic,
  in `src/server/auth/`. Auth.js-_compatible in shape_ (a provider seam, a
  session concept, typed errors) but **not the NextAuth library**.
- **Why not NextAuth v5?** NextAuth's Credentials provider does not support the
  database-session strategy (it forces stateless JWTs). Every hard requirement of
  this phase — role/status read from the DB on every request, instant session
  revocation, immediate lock-out of disabled users, server-side session
  validation, logout invalidation — needs database sessions. The Phase 2 schema
  already shipped a hashed-token `Session` model (not the NextAuth-adapter
  shape), so a custom implementation is consistent with the approved schema and
  avoids reshaping approved models. Additional providers (OAuth) can be added
  beside `authenticateWithCredentials` without touching the session layer.
  _Flagged for CTO ratification (see Phase 3 report §19)._
- **Provider seam:** `authenticateWithCredentials(input, deps)` returns a
  `SafeUser` (never a hash) or throws a typed error. `login()` / `logout()` add
  the Next.js cookie + request wiring.

## 2. Session strategy

| Property   | Choice                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| Token      | 32 random bytes, base64url, generated server-side                                                                         |
| Storage    | Only `sha256`/HMAC(`AUTH_SECRET`) of the token, in `Session.tokenHash`                                                    |
| Cookie     | `taek_session` — `httpOnly`, `SameSite=Lax`, `Secure` in production, `Path=/`                                             |
| Lifetime   | Absolute 30 days (`SESSION_TTL_SECONDS`); no silent extension                                                             |
| Validation | Every request: hash → DB lookup → expiry check → `user.status === ACTIVE` check; role read fresh from the joined user row |
| Revocation | Logout deletes the row; password reset deletes **all** the user's rows; deactivation deletes all the user's rows          |
| Trust      | The cookie carries no identity or privilege data — only the opaque token                                                  |

## 3. Password security

- **Argon2id** via `@node-rs/argon2` (prebuilt binaries: win32-x64, linux-x64
  gnu + musl, darwin — covers local dev, CI, and the future Alpine container).
- Parameters: OWASP defaults `m=19456 KiB, t=2, p=1`, tunable via
  `AUTH_ARGON_MEMORY_KIB` / `_TIME_COST` / `_PARALLELISM`. `needsRehash()`
  detects hashes below current policy.
- **Plaintext** is never stored, logged, or returned. `verifyPassword()` returns
  `false` (never throws) for wrong/absent/malformed hashes.
- **`passwordHash` isolation:** read by exactly two repo functions
  (`findCredentialsByEmail`, `findCredentialsById`); every other read uses
  `safeUserSelect`, which omits the column. It is structurally impossible to
  leak it through a normal query or API response.
- **Policy** (`src/server/auth/password-policy.ts`, the single source):
  min 10 / max 128 chars, small embedded common-password blocklist, reject
  low-entropy repeats, reject leading/trailing whitespace, reject strings
  containing the user's email local-part or name. Composition rules (forced
  symbols/case) deliberately **not** used (NIST SP 800-63B).
- **Timing:** unknown-user logins still run one Argon2id verify against a fixed
  dummy hash, so response time does not reveal account existence.

## 4. Roles & authorization

Hierarchy (`ROLE_RANK`): `CUSTOMER (100) < STAFF (200) < MANAGER (300) < ADMIN (400)`.

| Role     | Intent                        | Permissions (cumulative)                                                       |
| -------- | ----------------------------- | ------------------------------------------------------------------------------ |
| CUSTOMER | Storefront / own account only | _none internal_                                                                |
| STAFF    | Limited internal read         | `catalog.read`, `inventory.read`, `order.read`                                 |
| MANAGER  | Operational management        | + `catalog.write`, `inventory.write`, `order.write`, `import.run`, `user.read` |
| ADMIN    | Full control                  | + `audit.read`, `user.role.write`, `user.status.write`, `settings.write`       |

- **Server-side enforced, always.** Guards (`requireUser`, `requireRole`,
  `requireAnyRole`, `requirePermission`) live in `src/server/auth/authorization.ts`
  and are called inside every service function — never only in the UI or proxy.
- **`requireRole`** = "this rank or higher"; **`requireAnyRole`** = exact set.
- **Permission model** is layered on top so fine-grained grants can be added
  later without changing the hierarchy.
- **Privilege-escalation rule** (`canAssignRole`): ADMIN may assign any role
  (including ADMIN — admins appoint admins); anyone else may assign only roles
  strictly below their own rank. Enforced even though only ADMIN currently holds
  `user.role.write`.
- **Self-modification:** no user may change their own role
  (`SelfRoleChangeError`) or their own account status.
- **Proxy gate** (`src/proxy.ts`) only does an _optimistic_ cookie-presence
  redirect for `/admin`; it is UX, never the security boundary (Edge runtime,
  no DB).

## 5. Account status

`UserStatus`: `ACTIVE`, `INVITED`, `SUSPENDED`, `DEACTIVATED`. Only `ACTIVE`
users authenticate. A non-`ACTIVE` status:

- fails login (generic `Invalid email or password.` — no disclosure);
- fails `validateSessionToken` on the very next request (`status: "disabled"`);
- and, when set by an admin, immediately deletes all of that user's sessions.

Users are never deleted to disable them.

## 6. CSRF

- **Server Actions:** Next.js's built-in Origin/Host check.
- **Hand-written mutating route handlers:** `guardMutation()` =
  (a) same-origin check (`Origin`/`Referer` vs configured app origin) +
  (b) double-submit token — non-`httpOnly` `taek_csrf` cookie echoed in the
  `x-csrf-token` header (or `csrfToken` form field). `GET /api/auth/session`
  issues the cookie.

## 7. Audit log

- Generic append-only `AuditLog` (`actorUserId?`, `action`, `entityType?`,
  `entityId?`, `metadata` JSON, `ipAddress?`, `userAgent?`, `createdAt`), indexed
  on `actorUserId`, `action`, `(entityType, entityId)`, `createdAt`.
- `action` is a dotted string constant (`src/server/audit/actions.ts`), not an
  enum, so business events extend it without a migration.
- **`recordAudit`** always sanitises metadata (`sanitizeAuditMetadata`): keys
  matching `pass*/secret/token/hash/salt/credential/authorization/cookie/…` are
  redacted, functions/symbols dropped, depth/breadth/string length capped, output
  guaranteed plain JSON. A failed write is logged, never rethrown.
- **Never logged / audited:** plaintext passwords, password hashes,
  reset-token secrets, session tokens/secrets, raw credentials.
- Phase 3 events: `auth.login.succeeded|failed`, `auth.logout`,
  `auth.password.changed|reset_requested|reset_completed`,
  `auth.email.verification_requested|verified`, `user.created`,
  `user.role.changed`, `user.status.changed`.

## 8. Rate limiting

- `RateLimiter` interface + `InMemoryRateLimiter` (fixed window). Applied to
  login (per email + per IP), password-reset request, verification request.
- **Production requirement (deferred):** a shared store (Redis / Upstash / a DB
  counter) for multi-instance correctness. The in-memory limiter is per-process
  only. Swap the `rateLimiter` binding in `src/server/auth/rate-limit.ts`; no
  other code changes.

## 9. Application security headers

Set for every response (static ones in `next.config.ts`, dynamic in `src/proxy.ts`):

| Header                       | Value                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Content-Security-Policy`    | `default-src 'self'`; `script-src 'self' 'nonce-…' 'strict-dynamic'` (+ `'unsafe-eval'` in dev only); `style-src 'self' 'unsafe-inline'`; `img-src 'self' data: blob:`; `connect-src 'self'`; `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`; `frame-ancestors 'none'`; `upgrade-insecure-requests` (prod) |
| `X-Content-Type-Options`     | `nosniff`                                                                                                                                                                                                                                                                                                                |
| `X-Frame-Options`            | `DENY`                                                                                                                                                                                                                                                                                                                   |
| `Referrer-Policy`            | `strict-origin-when-cross-origin`                                                                                                                                                                                                                                                                                        |
| `Permissions-Policy`         | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()`                                                                                                                                                                                                                                       |
| `Cross-Origin-Opener-Policy` | `same-origin`                                                                                                                                                                                                                                                                                                            |
| `Strict-Transport-Security`  | `max-age=63072000; includeSubDomains; preload` (production only)                                                                                                                                                                                                                                                         |

### CSP items intentionally deferred

- **`style-src 'unsafe-inline'`** — Tailwind v4 + framework style injection.
  Tighten to nonce/hash once the Phase 4 component system stabilises.
- **`connect-src` / `img-src` / `frame-src` for third parties** — Stripe.js,
  the S3/CDN image host, and any analytics are unknown until Phase 7/9. Their
  origins get added then.
- **`report-uri` / `report-to`** — no CSP reporting endpoint yet.
- **Nonced `<Script>` for future inline scripts** — none exist today.

## 10. Known limitations / technical debt

- **Live-DB verification still outstanding** (no Docker/Postgres in the
  environment): `prisma migrate deploy`, seeding a real admin, and DB-backed
  integration/e2e for the full sign-in→session→logout loop. Unit tests cover the
  logic with a mocked Prisma; e2e covers the DB-free paths (redirects, headers,
  401s, CSRF rejection).
- **In-memory rate limiter** — see §8.
- **No email delivery** — password-reset / email-verification create and consume
  tokens correctly; the `Mailer` seam has only a `NoopMailer`. A real transport
  is Phase 4+.
- **No brute-force account lockout** beyond rate limiting (no `failedAttempts`
  counter on `User`); revisit if abuse is observed.
- **`npm audit`** — one dev-only transitive advisory in the Prisma CLI
  (`deepmerge-ts` via `@prisma/config`); not in the production tree, not
  exploitable here. See the Phase 2/3 reports.
- **CSP** deferrals — see §9.
- **Self-registration (customer sign-up)** is intentionally not built — Phase 4
  storefront work.
