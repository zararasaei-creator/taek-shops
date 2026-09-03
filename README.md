# Taek Shops

A secure, maintainable, responsive, multilingual-ready **Canadian e-commerce
platform** for taekwondo uniforms, belts, protective gear, training equipment,
and accessories.

> **Project status: Phases 1–6 complete; Phase 7 (Stripe payments) awaiting CTO
> review.** The toolchain, Prisma/PostgreSQL schema, auth/RBAC/audit, the product
> catalogue + CSV importer, the hardened inventory domain, the storefront cart +
> configured tax/shipping + checkout, and now **Stripe payments** — a
> `PaymentGateway` interface, server-derived charge amounts, the Payment Element,
> and a signature-verified, idempotent webhook that moves a paid order
> `pending → paid` (commit stock) or a failed one `→ cancelled` (release stock) —
> are in place and verified against a live PostgreSQL database. The browser
> card-entry e2e needs a Stripe test account (see the roadmap).

## Documentation

- [Architecture](docs/architecture.md) — system context, modules, boundaries,
  security, testing, deployment, key decisions.
- [Security notes](docs/security.md) — auth, sessions, RBAC, audit, headers,
  deferrals.
- [Catalogue, inventory & import](docs/catalog.md) — product/variant/option
  model, lifecycle, inventory rules, image storage, CSV import workflow.
- [Implementation roadmap](docs/implementation-roadmap.md) — phased plan with
  acceptance criteria.
- [Product import specification](docs/product-import-specification.md) — full
  future importer spec ([Phase 4 template](docs/product-import-template.csv)).

## Tech stack

Next.js 16 (App Router) · TypeScript (strict) · React 19 · Tailwind CSS v4 ·
Zod · PostgreSQL + Prisma 6.19 · custom credentials auth + DB sessions
(`@node-rs/argon2`) · Vitest + Testing Library · Playwright · ESLint · Prettier ·
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
- From Phase 2, `DATABASE_URL` is required. `AUTH_SECRET` (a ≥16-char pepper) is
  optional but strongly recommended for Phase 3+.
- **Stripe (Phase 7):** set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and
  `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` to **test-mode** values to enable the
  payment step. Locally, run `stripe listen --forward-to localhost:3000/api/webhooks/stripe`
  and use the secret it prints. Without these, checkout still creates the pending
  order but payment is disabled.
- **Development admin:** set `SEED_ADMIN_EMAIL` + `SEED_ADMIN_PASSWORD` in `.env`,
  then `npm run db:seed` creates one `ADMIN` user (password hashed, never
  printed). Dev/demo only — never set these in production.

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
| `npm run build`        | Production build                                    |
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

| Command                    | What it does                                                      |
| -------------------------- | ----------------------------------------------------------------- |
| `npm run test`             | Vitest unit/component tests (mocked Prisma, single run)           |
| `npm run test:watch`       | Vitest in watch mode                                              |
| `npm run test:integration` | DB-backed integration tests (needs Docker Postgres + `db:deploy`) |
| `npm run test:e2e`         | Playwright end-to-end tests (builds + starts the app)             |
| `npm run test:e2e:ui`      | Playwright in UI mode                                             |

> First e2e run only: `npx playwright install` to download browser binaries.
>
> `test:integration` **and** (from Phase 6) `test:e2e` need a live database —
> the storefront reads it: `docker compose up -d && npm run db:deploy && npm run db:seed`.
> The e2e run seeds/removes its own isolated checkout fixture.
> The authenticated-flow e2e (`auth-session.spec.ts`) runs only when
> `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD` are set to a seeded admin.

## Build command

```bash
npm run build
```

## Full verification pipeline

```bash
npm ci && npm run format:check && npm run lint && npm run typecheck && npm run test && npm run build
# from Phase 5 on, with Docker Postgres running (docker compose up -d && npm run db:deploy):
npm run test:integration && npm run test:e2e
```

## Project structure

```
src/
  app/
    (storefront)/        Storefront routes (public)
    admin/               Admin dashboard + /admin/catalog management UI
    api/                 Route handlers (auth, admin/users, admin/catalog, import, media, health)
  components/            Shared UI + admin form primitives
  lib/
    validation/          Shared Zod schemas (auth, catalog)
    http/                Route-handler helpers (CSRF, error mapping, request meta)
  proxy.ts               Edge proxy: security headers (CSP) + optimistic /admin gate
  server/
    config/env.ts        Validated environment configuration
    auth/                Credentials auth, DB sessions, RBAC, password/token handling
    audit/               Generic append-only audit log + sanitisation
    users/               Admin user-management services (server-enforced)
    catalog/             Brand/category/product/variant/option/image services + public queries
    inventory/           Row-locked stock transactions, reconcilable ledger, invariant check
    cart/                Guest/customer carts, server-recomputed line prices
    tax/  shipping/      TaxCalculator / ShippingRateProvider over operator-configured tables
    domain/payments/     PaymentGateway interface + Stripe implementation
    orders/              Checkout, payment orchestration, order-lifecycle inventory wiring
    storage/             ObjectStorage interface + local dev backend
    import/              CSV product import (parse -> validate -> preview -> commit)
    domain/money.ts      Integer-cents money helper
    db/                  Prisma client singleton + repositories
prisma/
  schema.prisma          Database schema of record (29 models, 19 enums)
  migrations/            Migration history
  seed.ts                Synthetic development seed
prisma.config.ts         Prisma CLI configuration
tests/
  unit/                  Vitest, mocked Prisma (services, schema invariants, money, env)
  integration/           Vitest, live Postgres (inventory transactions, concurrency, invariant, order lifecycle)
  e2e/                   Playwright
docs/                    Architecture, roadmap, catalog/inventory, import spec, security
infra/                   Deployment assets
docker-compose.yml       Local PostgreSQL
```

## License

Proprietary — © Taek Shops. All rights reserved.
