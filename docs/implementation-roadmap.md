# Taek Shops — Implementation Roadmap

Small, independently testable phases. A phase is **Complete** only when every
acceptance criterion is implemented **and verified** by the stated checks. No
phase may be marked complete on the basis of scaffolding alone.

**Verification pipeline** (run for every phase):
`npm ci` → `npm run format:check` → `npm run lint` → `npm run typecheck` →
`npm run test` → `npm run build` (+ `npm run test:e2e` from Phase 3 on).

Legend: ✅ Complete · 🚧 In progress · ⬜ Not started

---

## Phase 1 — Project foundation ✅

**Goal:** a buildable, lint-clean, type-safe application shell with the full
toolchain and the design documents.

**Scope**

- Next.js (App Router) + TypeScript strict + Tailwind v4 scaffold.
- Directory structure separating storefront / admin / auth / domain / db /
  validation / import / shared UI / tests / infra.
- ESLint + Prettier + strict `tsconfig` + absolute imports (`@/*`).
- Environment validation module (`src/server/config/env.ts`, Zod).
- Vitest (unit/component) + Playwright (structure) configured.
- `docker-compose.yml` for local PostgreSQL.
- `.env.example` (names only), `.gitignore` hardened.
- `docs/architecture.md`, `docs/implementation-roadmap.md`,
  `docs/product-import-specification.md`, root `README.md`.
- Minimal shell: root layout, storefront home, admin placeholder, `/api/health`.

**Out of scope:** database schema, auth, catalogue, cart, checkout, payments,
the importer itself.

**Acceptance criteria**

- [x] `npm run format:check` passes.
- [x] `npm run lint` passes with no warnings.
- [x] `npm run typecheck` passes (no `any`, strict on).
- [x] `npm run test` passes (env + component smoke tests).
- [x] `npm run build` produces a production build.
- [x] `/` and `/admin` render; `/api/health` returns `{ status: "ok" }`.
- [x] No secrets, tax rates, shipping prices, or URLs hard-coded.
- [x] Three design docs present and consistent with the code layout.

---

## Phase 2 — Database foundation (Prisma) ✅ _(signed off 2026-09-03)_

**Goal:** production-ready PostgreSQL schema + Prisma wiring. No UI, no features.

**Scope (delivered)**

- `prisma` 6.19.x + `@prisma/client`; `prisma.config.ts` (loads `.env`).
- `prisma/schema.prisma` — 29 models, 19 enums covering identity, catalogue
  (normalised options), inventory ledger, cart, orders with historical
  snapshots, payments, operator-configurable tax & shipping, discounts, and
  import-job tracking.
- Integer-cents money everywhere; `Currency` enum default `CAD`; `Decimal` only
  for tax/discount rates.
- `src/server/db/client.ts` — hot-reload-safe singleton client.
- `src/server/domain/money.ts` — cents parse / arithmetic / format helper.
- Initial migration `prisma/migrations/20260903000000_init/`.
- Idempotent synthetic seed (`prisma/seed.ts`): categories, one brand, one demo
  product with Size/Colour options + 4 variants + inventory + opening
  movements, example ON tax region/rate, example shipping zone/method. No
  customers, no secrets.
- `DATABASE_URL` now **required** in `src/server/config/env.ts`.
- Schema-invariant + money unit tests.

**Acceptance criteria**

- [x] `prisma validate` passes; `prisma generate` produces the client.
- [x] `tsc`, ESLint, Prettier, `next build`, and all Phase 1 tests stay green.
- [x] Schema-invariant tests: integer cents on every money field, critical
      `@unique` constraints present, cuid ids, timestamp conventions.
- [x] `money.ts` arithmetic/formatting covered by unit tests.
- [x] Seed script is written, idempotent by construction, and reaches the DB
      layer (verified up to the connection boundary); contains no real data.
- [x] Initial migration generated offline (`prisma migrate diff --from-empty`)
      and verified deterministic (byte-identical on regeneration).

**CTO sign-off note (2026-09-03):** Phase 2 approved. Docker/PostgreSQL was not
available in any authoring environment, so the following were **not executed**
and are carried as a **Phase 3 pre-flight task** (run once, before Phase 3 code):

```
docker compose up -d
npm run db:deploy      # apply 20260903000000_init to a clean DB
npm run db:seed        # load synthetic data
npm run db:deploy && npm run db:seed   # confirm both are idempotent
```

Repository/integration tests against a live Postgres also land at the start of
Phase 3 (alongside the auth work), not retroactively in Phase 2.

---

## Phase 3 — Authentication, authorization & audit 🚧 _(awaiting CTO review, 2026-09-03)_

**Scope (delivered)**

- Custom credentials auth + **database sessions** in `src/server/auth/`
  (Auth.js-compatible shape; not the NextAuth library — rationale in
  `docs/security.md` §1). Provider-extensible.
- Argon2id password hashing (`@node-rs/argon2`); `passwordHash` structurally
  isolated to two repo functions; centralised password policy.
- RBAC: `CUSTOMER < STAFF < MANAGER < ADMIN` + layered `Permission` map;
  `requireUser/Role/AnyRole/Permission` guards; `canAssignRole` escalation rule;
  self-role / self-status change blocked.
- Session cookie (`httpOnly`, `SameSite=Lax`, `Secure` in prod); logout,
  password-reset, and deactivation all revoke sessions; disabled users rejected
  at login and on every request.
- Password-reset + email-verification foundations (token create/consume,
  `Mailer` seam with `NoopMailer` — no delivery yet).
- `RateLimiter` interface + in-process limiter on login / reset / verification.
- Generic `AuditLog` model + `recordAudit` with metadata sanitisation; auth &
  user-management events emitted.
- Admin user-management services (list / inspect / role / status) + minimal
  route handlers + a minimal `/login` page and server-gated `/admin`.
- Security headers: nonce CSP via `src/proxy.ts` (Next 16 rename of middleware);
  static headers via `next.config.ts`.
- Schema: `+ MANAGER` role, `+ AuditLog`, `+ User.lastLoginAt` — migration
  `20260904000000_phase3_auth`.
- Optional dev admin seed (`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`), idempotent,
  password never logged.

**Acceptance criteria**

- [x] Unauthenticated `/admin` redirects to `/login`; `/api/admin/*` returns 401
      (e2e).
- [x] Role/permission allow-deny matrix + escalation + self-change unit tests.
- [x] Argon2id hashing, verification, policy, timing-safe unknown-user path
      (unit tests).
- [x] Session issue/validate/expire/disable/revoke (unit tests, mocked Prisma).
- [x] Audit events created for security actions; secrets absent from metadata
      (unit tests).
- [x] Security headers present (e2e); CSP does not break the app.
- [x] `prisma validate` / `generate` / migration determinism.
- [x] `typecheck`, `lint`, `test` (all Phase 1–3), `build` green.
- [ ] **Blocked (no Docker/Postgres in environment):** live `migrate deploy`,
      real admin seed, and DB-backed e2e for the full sign-in → session →
      logout loop. Carried to the Phase 4 pre-flight.

**Deferred to Phase 4+:** real email transport; shared-store rate limiter;
customer self-registration UI; account-settings UI; brute-force lockout counter;
tightening `style-src` off `'unsafe-inline'`.

---

## Phase 4 — Catalogue, inventory, admin management & import foundation 🚧 _(awaiting CTO review, 2026-09-05)_

Per the Phase 4 CTO brief this phase absorbed the inventory adjustment domain
(was Phase 5) and the CSV import foundation (was Phase 10). Full design:
[`docs/catalog.md`](catalog.md).

**Scope (delivered)**

- **Catalogue services** (`src/server/catalog/`): brand, category (tree +
  cycle checks), product (lifecycle `DRAFT/ACTIVE/ARCHIVED`), normalised
  options/values, variants (unique SKU, complete option coverage, no duplicate
  combinations — enforced app + DB), images. All authorization server-side.
- **Public storefront query layer** (`catalog-queries.ts`) — status-filtered so
  drafts/archived products can never be exposed. (Storefront _pages_ remain a
  later phase.)
- **Inventory domain** (`src/server/inventory/`): single `adjustInventory` entry
  point (delta / set, reason, movement type, reference), transactional, on-hand
  never negative / never below reserved, every change writes a `StockMovement` +
  `AuditLog`. Order-flow primitives (reserve/release/commit/restock) implemented,
  not yet wired to orders.
- **Image-storage abstraction** (`src/server/storage/`): `ObjectStorage`
  interface + local dev backend + `GET /api/media`. S3 backend deferred.
- **CSV product import** (`src/server/import/`): file/header/row validation,
  normalisation, dry-run preview (zero writes), row-level errors, per-row
  transactional commit with upsert-by-SKU, summary, `ImportJob`/`ImportJobRow`
  audit trail, formula-injection defence, idempotency. XLSX deferred (seam in
  place). Template: `docs/product-import-template.csv`.
- **Additive schema change** — `ProductVariant.optionSignature` +
  `@@unique([productId, optionSignature])` (migration
  `20260905000000_phase4_catalog`). No Phase 2/3 model changed.
- **Admin UI** under `/admin/catalog` (products list/create/edit, brands,
  categories, inventory, import) — server components + server actions.
- 20 new AuditLog action constants; 64 new unit tests; 5 new e2e checks.

**Acceptance criteria**

- [x] Admin can create a product with ≥ 2 variants (unit + UI); duplicate SKU and
      duplicate option combinations are rejected (unit + DB constraint).
- [x] Integer-cent money throughout; `parseAmountToCents` covered.
- [x] Inventory can only change through the adjustment service; invalid
      transitions blocked (unit).
- [x] CSV validation, dry-run (no writes), invalid-row isolation, normalisation
      covered (unit).
- [x] Authorization enforced in every catalog/inventory/import mutation (unit +
      e2e 401/403/CSRF).
- [x] `typecheck`, `lint`, `prettier`, `next build`, `prisma validate/generate`,
      **181** unit tests, **13** e2e — all green.
- [ ] **Blocked (no Docker/PostgreSQL):** `migrate deploy`, seed, DB-backed
      integration/e2e for catalogue CRUD, variant constraints, inventory
      transactions, and the import preview→commit→re-import idempotency round
      trip. Release-blocking; carried to the Phase 5 pre-flight.
- [ ] Storefront pages, faceted filtering UI, accessibility/perf budgets — not in
      this phase's scope (public query layer is done and tested).

---

## Phase 5 — Inventory (hardening) ⬜

The inventory adjustment domain, ledger, low-stock view, and order-flow
primitives were delivered in Phase 4 (`src/server/inventory/`). Remaining:

**Scope**

- Concurrency: conditional updates / row locks so parallel reservations cannot
  oversell (needs a real DB to test).
- Property test: `onHand` reconciles with the sum of `StockMovement.quantityDelta`.
- Wire the reserve/release/commit/restock primitives into order placement /
  cancellation (Phase 6+).

**Acceptance criteria**

- [ ] Concurrent reservation cannot oversell (integration test, parallel txns).
- [ ] `onHand` == sum of movements (property test against a real DB).
- [ ] Full verification pipeline green.

---

## Phase 6 — Cart & checkout (no real payment) ⬜

**Scope**

- Cart (guest + customer), server-recomputed totals.
- Checkout: address entry, shipping method selection, order review.
- `TaxCalculator` + `ShippingRateProvider` interfaces with
  operator-configured implementations (rates/rules entered via admin, stored in
  DB — none committed to source).
- Order creation transaction: create `Order`, reserve stock, freeze totals.

**Acceptance criteria**

- [ ] Client cannot alter prices/totals (server recompute test).
- [ ] Tax and shipping are quoted from configured data and frozen onto the order.
- [ ] Order creation + stock reservation is atomic (integration test).
- [ ] e2e: cart → checkout → order in `pending` state.
- [ ] Full verification pipeline green.

---

## Phase 7 — Payments (Stripe) ⬜

**Scope**

- `PaymentGateway` interface + Stripe implementation.
- PaymentIntent creation with idempotency key; Stripe Payment Element on client.
- Webhook handler (signature-verified, event-id de-duped): success → `paid` +
  commit stock; failure/expiry → `cancelled` + release stock.
- No card data stored.

**Acceptance criteria**

- [ ] Stripe test-mode payment moves an order `pending → paid` and commits stock.
- [ ] Failed payment releases reserved stock.
- [ ] Webhook replay / duplicate event is a no-op (test).
- [ ] Unsigned webhook rejected (test).
- [ ] No PAN/CVV/expiry persisted anywhere (code + schema review documented).
- [ ] e2e checkout with Stripe test card passes in CI.
- [ ] Full verification pipeline green.

---

## Phase 8 — Order management ⬜

**Scope**

- Admin order list/detail; state machine
  (`paid → fulfilled → completed`, `cancelled`, `refunded`).
- Refund via `PaymentGateway.refund`; stock return movements.
- Customer order history + order detail.
- Transactional emails (confirmation, shipped) behind a `Mailer` interface.

**Acceptance criteria**

- [ ] Every state transition is validated and audit-logged.
- [ ] Refund updates order, payment, and inventory consistently (integration test).
- [ ] Customer sees only their own orders (authz test).
- [ ] Full verification pipeline green.

---

## Phase 9 — Product image management ⬜

**Scope**

- `ObjectStorage` interface + S3-compatible implementation; MinIO in local
  docker-compose.
- Signed direct-upload flow; `ProductImage` records; ordering; alt text.
- Next `<Image>` remote pattern config.

**Acceptance criteria**

- [ ] Admin uploads an image; it renders on the storefront via the CDN URL.
- [ ] Deleting a product/variant cleans up storage objects (test).
- [ ] Upload rejects oversized / wrong content-type files (test).
- [ ] Full verification pipeline green.

---

## Phase 10 — Spreadsheet import (CSV/XLSX) ⬜

**Scope:** implement the full pipeline in `docs/product-import-specification.md`
— template download, upload, column mapping, validation, preview, commit
(create/update/upsert), duplicate detection, progress, summary, transaction-safe
writes, import history + audit, formula-injection protection, configurable
size/row caps, safe price/stock updates, downloadable error report.

**Acceptance criteria**

- [ ] Template downloads as both `.csv` and `.xlsx` with the documented columns.
- [ ] Valid file: preview counts match; commit creates/updates exactly as previewed.
- [ ] Invalid rows produce row-level errors and never partially write.
- [ ] Upsert by `sku` is idempotent (re-importing the same file is a no-op).
- [ ] In-file duplicate `sku` is reported, not silently merged.
- [ ] Formula-injection payloads (`=cmd`, `@SUM`, `+…`, `-…`) are neutralised (test).
- [ ] File over `IMPORT_MAX_FILE_SIZE_BYTES` or row count over `IMPORT_MAX_ROW_COUNT` is rejected with a clear message.
- [ ] Price/stock updates go through domain services and write movements + audit.
- [ ] `ImportBatch` / `ImportRow` history is queryable in the admin UI.
- [ ] Crash mid-commit leaves the DB consistent (chunked-transaction test).
- [ ] e2e: upload → map → preview → commit → summary; and the error-report path.
- [ ] Full verification pipeline green.

---

## Phase 11 — Tax & shipping configuration UI ⬜

**Scope**

- Admin screens to manage `TaxRate` (province × tax category) and shipping rules
  (province / weight band / subtotal threshold / free-shipping).
- Optional external-provider adapters stubbed behind the existing interfaces.

**Acceptance criteria**

- [ ] Operator can configure rates/rules; checkout quotes reflect them.
- [ ] No rate or price value is present in source control (review documented).
- [ ] Interface contract tests pass for every implementation.
- [ ] Full verification pipeline green.

---

## Phase 12 — Internationalisation readiness ⬜

**Scope**

- Introduce `next-intl` (or equivalent); extract storefront copy to message
  catalogues; `en-CA` default, `fr-CA` scaffold; locale routing.

**Acceptance criteria**

- [ ] No hard-coded user-facing strings in storefront components (lint rule).
- [ ] Locale switch renders translated pages; missing keys fail CI.
- [ ] Full verification pipeline green.

---

## Phase 13 — Hardening & production deployment ⬜

**Scope**

- `Dockerfile` (standalone, non-root) + CI/CD pipeline.
- Security headers / CSP in middleware; rate limiting.
- Structured logging, error tracking, uptime + health monitoring.
- Backup/restore runbook; expand/contract migration policy documented.
- Load test of catalogue + checkout; performance budget enforced.

**Acceptance criteria**

- [ ] Image builds in CI and boots with only documented env vars.
- [ ] `prisma migrate deploy` runs as a pre-deploy step against staging.
- [ ] Security header scan passes an agreed baseline.
- [ ] Rollback procedure exercised on staging.
- [ ] Full verification pipeline green + e2e against a deployed staging URL.

---

## Cross-cutting, ongoing

- Accessibility (WCAG 2.1 AA target) and responsive checks every UI phase.
- `npm audit` / dependency review in CI.
- No real customer or business data in any fixture, seed, or test.
- Docs kept in sync: update `architecture.md` when a boundary changes.
