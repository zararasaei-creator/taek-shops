# Taek Shops

A secure, maintainable, responsive, multilingual-ready **Canadian e-commerce
platform** for taekwondo uniforms, belts, protective gear, training equipment,
and accessories.

> **Project status: Phase 1 (foundation).** This repository currently contains
> the application shell, toolchain, and design documents only. The storefront,
> admin dashboard, database schema, payments, and the spreadsheet importer are
> planned work — see the roadmap.

## Documentation

- [Architecture](docs/architecture.md) — system context, modules, boundaries,
  security, testing, deployment, key decisions.
- [Implementation roadmap](docs/implementation-roadmap.md) — phased plan with
  acceptance criteria.
- [Product import specification](docs/product-import-specification.md) —
  spreadsheet columns and rules for the bulk importer.

## Tech stack

Next.js 16 (App Router) · TypeScript (strict) · React 19 · Tailwind CSS v4 ·
Zod · Vitest + Testing Library · Playwright · ESLint · Prettier ·
PostgreSQL + Prisma _(from Phase 2)_ · Auth.js _(from Phase 3)_ ·
Stripe / S3-compatible storage _(later phases, behind interfaces)_.

## Prerequisites

- **Node.js ≥ 20.11** and **npm ≥ 10** (this repo uses npm; the lockfile is
  committed).
- **Docker** + Docker Compose — for the local PostgreSQL instance (needed from
  Phase 2; not required to run the Phase 1 shell).

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
- For Phase 1 the shell runs with no `.env` at all (safe defaults apply).

## Database (local)

```bash
# Set POSTGRES_PASSWORD (and optionally POSTGRES_USER/DB/PORT) in .env first.
docker compose up -d        # start PostgreSQL 17
docker compose ps           # check health
docker compose down         # stop (data persists in the named volume)
docker compose down -v      # stop and delete data
```

Then set `DATABASE_URL` in `.env`, e.g.
`postgresql://taek:<password>@localhost:5432/taek_shops`.
Prisma schema and migrations arrive in Phase 2.

## Development commands

| Command                | What it does                                     |
| ---------------------- | ------------------------------------------------ |
| `npm run dev`          | Start the dev server (http://localhost:3000)     |
| `npm run build`        | Production build (`output: "standalone"`)        |
| `npm start`            | Run the production build (after `npm run build`) |
| `npm run lint`         | ESLint                                           |
| `npm run lint:fix`     | ESLint with autofix                              |
| `npm run typecheck`    | `next typegen` + `tsc --noEmit`                  |
| `npm run format`       | Prettier write                                   |
| `npm run format:check` | Prettier check (used in CI)                      |

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
    validation/          Shared Zod schemas (Phase 2+)
  server/
    config/env.ts        Validated environment configuration
    auth/                Auth.js integration (Phase 3)
    domain/              Business logic (Phase 2+)
    db/                  Database access — Prisma (Phase 2+)
    import/              Spreadsheet import pipeline (Phase 10)
tests/
  unit/                  Vitest
  e2e/                   Playwright
docs/                    Architecture, roadmap, import spec
infra/                   Deployment assets
docker-compose.yml       Local PostgreSQL
```

## License

Proprietary — © Taek Shops. All rights reserved.
