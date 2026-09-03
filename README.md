# Taek Shops

A secure, maintainable, responsive, multilingual-ready **Canadian e-commerce
platform** for taekwondo uniforms, belts, protective gear, training equipment,
and accessories.

> **Project status: Phase 2 (database foundation).** The application shell,
> toolchain, design documents, and the full Prisma/PostgreSQL schema + initial
> migration are in place. The storefront, admin dashboard, authentication,
> payments, and the spreadsheet importer are planned work — see the roadmap.

## Documentation

- [Architecture](docs/architecture.md) — system context, modules, boundaries,
  security, testing, deployment, key decisions.
- [Implementation roadmap](docs/implementation-roadmap.md) — phased plan with
  acceptance criteria.
- [Product import specification](docs/product-import-specification.md) —
  spreadsheet columns and rules for the bulk importer.

## Tech stack

Next.js 16 (App Router) · TypeScript (strict) · React 19 · Tailwind CSS v4 ·
Zod · PostgreSQL + Prisma 6.19 · Vitest + Testing Library · Playwright · ESLint ·
Prettier · Auth.js _(from Phase 3)_ ·
Stripe / S3-compatible storage _(later phases, behind interfaces)_.

## Prerequisites

- **Node.js ≥ 22.18** and **npm ≥ 10** (this repo uses npm; the lockfile is
  committed). Node 22.18+ runs the TypeScript seed script directly, with no
  extra tooling.
- **Docker** + Docker Compose — for the local PostgreSQL instance (required from
  Phase 2 on).

## Local setup

```bash
git clone <repository-url>
cd taek-shops
npm ci
cp .env.example .env   # then edit .env
```

## Environment configuration

- All configuration is read and **validated at startup** by
  [`src/server/config/env.ts`](src/server/config/env.ts) (Zod). A missing or
  malformed value fails fast with a readable message.
- `.env.example` lists every recognised variable **by name only**. Copy it to
  `.env` and fill in real values. **Never commit `.env`.**
- Browser-exposed values must be prefixed `NEXT_PUBLIC_`. Everything else is
  server-only and never bundled for the client.
- From Phase 2, `DATABASE_URL` is required; other integrations (auth, Stripe,
  storage) remain optional until their phase.

## Database (local)

Requires Docker. `DATABASE_URL` is **required** from Phase 2 on.

```bash
# 1. Set POSTGRES_PASSWORD (and optionally POSTGRES_USER/DB/PORT) in .env
# 2. Set DATABASE_URL in .env, e.g.:
#    postgresql://taek:<password>@localhost:5432/taek_shops?schema=public
docker compose up -d          # start PostgreSQL 17
npm run db:deploy             # apply migrations to a clean database
npm run db:seed               # load synthetic development data (idempotent)
docker compose down           # stop (data persists in the named volume)
docker compose down -v        # stop and delete data
```

Schema of record: [`prisma/schema.prisma`](prisma/schema.prisma).
See [architecture.md](docs/architecture.md) § "Database architecture" and
§ "Migration workflow".

## Development commands

| Command                | What it does                                        |
| ---------------------- | --------------------------------------------------- |
| `npm run dev`          | Start the dev server (http://localhost:3000)        |
| `npm run build`        | Production build (`output: "standalone"`)           |
| `npm start`            | Run the production build (after `npm run build`)    |
| `npm run lint`         | ESLint                                              |
| `npm run lint:fix`     | ESLint with autofix                                 |
| `npm run typecheck`    | `prisma generate` + `next typegen` + `tsc --noEmit` |
| `npm run format`       | Prettier write                                      |
| `npm run format:check` | Prettier check (used in CI)                         |

## Database commands

| Command                     | What it does                               |
| --------------------------- | ------------------------------------------ |
| `npm run db:migrate`        | Create + apply a migration in development  |
| `npm run db:deploy`         | Apply pending migrations (CI / production) |
| `npm run db:migrate:status` | Show migration state                       |
| `npm run db:seed`           | Run the synthetic seed (`prisma/seed.ts`)  |
| `npm run db:generate`       | Regenerate the Prisma client               |
| `npm run db:validate`       | Validate `schema.prisma`                   |
| `npm run db:format`         | Format `schema.prisma`                     |
| `npm run db:studio`         | Open Prisma Studio                         |
| `npm run db:reset`          | Drop, re-migrate, re-seed (**dev only**)   |

## Test commands

| Command               | What it does                                        |
| --------------------- | --------------------------------------------------- |
| `npm run test`        | Vitest unit/component tests (single run)            |
| `npm run test:watch`  | Vitest in watch mode                                |
| `npm run test:e2e`    | Playwright end-to-end tests (starts the dev server) |
| `npm run test:e2e:ui` | Playwright in UI mode                               |

> First e2e run only: `npx playwright install` to download browser binaries.

## Build command

```bash
npm run build
```

## Full verification pipeline

```bash
npm ci && npm run format:check && npm run lint && npm run typecheck && npm run test && npm run build
```

## Project structure

```
src/
  app/
    (storefront)/        Storefront routes (public)
    admin/               Admin dashboard (auth-gated in Phase 3)
    api/health/          Liveness probe
  components/ui/         Shared, accessible UI components
  lib/
    utils/               Small framework-agnostic helpers
    validation/          Shared Zod schemas (Phase 4+)
  server/
    config/env.ts        Validated environment configuration
    auth/                Auth.js integration (Phase 3)
    domain/money.ts      Integer-cents money helper
    db/client.ts         Prisma client singleton
    import/              Spreadsheet import pipeline (Phase 10)
prisma/
  schema.prisma          Database schema of record (29 models, 19 enums)
  migrations/            Migration history
  seed.ts                Synthetic development seed
prisma.config.ts         Prisma CLI configuration
tests/
  unit/                  Vitest (schema invariants, money, env, client)
  e2e/                   Playwright
docs/                    Architecture, roadmap, import spec
infra/                   Deployment assets
docker-compose.yml       Local PostgreSQL
```

## License

Proprietary — © Taek Shops. All rights reserved.
