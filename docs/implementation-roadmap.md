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

## Phase 2 — Database & domain primitives ⬜

**Goal:** persistence layer and money/enum primitives, no UI.

**Scope**

- Add Prisma; `prisma/schema.prisma` with Identity, Catalogue, Inventory models
  (Commerce + Operations models stubbed or included but unused).
- Prisma client singleton in `src/server/db/client.ts`; first repositories
  (`categories`, `brands`, `products`, `variants`, `inventory`).
- `Money` value object; attribute enumerations in `src/server/domain`.
- Seed script with **synthetic** data only.
- Integration tests against the docker Postgres.
- Make `DATABASE_URL` required in `env.ts`.

**Acceptance criteria**

- [ ] `prisma migrate dev` creates the schema from scratch; `prisma migrate deploy` works on a clean DB.
- [ ] Repository unit/integration tests pass against a real Postgres in CI.
- [ ] `Money` arithmetic/formatting covered by unit tests (rounding, CAD formatting).
- [ ] Seed script populates and is idempotent; contains no real data.
- [ ] Full verification pipeline green.

---

## Phase 3 — Authentication & authorization ⬜

**Scope**

- Auth.js (NextAuth v5) + Prisma adapter; email/password (Argon2id).
- `middleware.ts` gate for `/admin/**` and `/account/**`.
- `requireUser` / `requireStaff` / `requireAdmin` guards.
- Sign-in / sign-out / register UI (React Hook Form + Zod).
- `AuditLog` model + auth event logging.
- First Playwright e2e: admin can sign in, guest is redirected.

**Acceptance criteria**

- [ ] Unauthenticated request to `/admin` redirects; authorised staff reaches it.
- [ ] Role guard unit tests (allow/deny matrix) pass.
- [ ] Passwords stored only as Argon2id hashes; verified by test.
- [ ] Session revocation takes effect on next request (test).
- [ ] e2e sign-in flow passes in CI.
- [ ] Full verification pipeline green.

---

## Phase 4 — Catalogue (admin CRUD + storefront read) ⬜

**Scope**

- Admin: create/edit categories, brands, products, variants, typed attributes.
- Storefront: category listing, product detail, variant selection, CAD pricing
  display, `compareAtPrice` "was" price.
- Faceted filtering (size, colour, gender, age group, brand, product type).
- Accessible, responsive components; SEO metadata; sitemap.

**Acceptance criteria**

- [ ] Admin can create a product with ≥2 variants and see it on the storefront.
- [ ] Filters produce correct result sets (integration tests).
- [ ] Product pages pass an automated accessibility check (axe) with no serious violations.
- [ ] Lighthouse/perf budget for product page met (documented threshold).
- [ ] e2e: browse → product → select variant.
- [ ] Full verification pipeline green.

---

## Phase 5 — Inventory ⬜

**Scope**

- `InventoryItem` + `StockMovement` ledger; `available` derivation.
- Admin: adjust stock (writes a movement + audit), low-stock view.
- Domain `InventoryService` (receive / adjust / reserve / release / commit).

**Acceptance criteria**

- [ ] `onHand` always equals the sum of movements (property test).
- [ ] Concurrent reservation cannot oversell (integration test with parallel txns).
- [ ] Low-stock threshold surfaces items correctly.
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
