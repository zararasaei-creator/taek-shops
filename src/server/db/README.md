# Database access (`src/server/db`)

All PostgreSQL access goes through this module. Nothing outside `src/server`
imports a database client directly, and there is never more than one
`PrismaClient` in a process.

## Contents

- **`client.ts`** — the shared `prisma` client. Cached on `globalThis` in
  development so Next.js hot-reload does not open a new connection pool on every
  edit. In production a single module instance is used.
- **`users-repo.ts`** — user queries. `safeUserSelect` omits `passwordHash`;
  `findCredentialsByEmail` / `findCredentialsById` are the ONLY functions that
  read it, for the authenticator and self-service password change.
- **`sessions-repo.ts`** — session create / lookup-by-hash / revoke helpers.

## Related (outside this folder)

- **`prisma/schema.prisma`** — schema of record (29 models, 19 enums).
- **`prisma/migrations/`** — migration history. `20260903000000_init` is the
  baseline.
- **`prisma/seed.ts`** — synthetic development seed (`npm run db:seed`).
- **`prisma.config.ts`** — Prisma CLI configuration (loads `.env`).
- **`src/server/domain/money.ts`** — the only place money (integer cents) is
  parsed / formatted / calculated.

## Planned (Phase 4+)

Repository / query helpers grouped by aggregate (`categories.ts`, `brands.ts`,
`products.ts`, `variants.ts`, `inventory.ts`, `orders.ts`), each exposing typed
functions instead of raw client calls.

## Commands

See `docs/architecture.md` § "Migration workflow" and the root `README.md`.
