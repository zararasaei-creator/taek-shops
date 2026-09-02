# Authentication & authorization (`src/server/auth`)

Wraps Auth.js (NextAuth v5). Exposes `auth()`, sign-in/out handlers, the session
type, and role guard helpers (`requireUser`, `requireAdmin`).

**Planned contents (auth phase):**

- `config.ts` — Auth.js configuration (providers, session strategy, callbacks).
- `index.ts` — re-exported `auth`, `handlers`, `signIn`, `signOut`.
- `guards.ts` — server-side role checks used by admin routes and server actions.

Authorization model (roles: `customer`, `staff`, `admin`) is described in
`docs/architecture.md`. Not implemented in Phase 1.
