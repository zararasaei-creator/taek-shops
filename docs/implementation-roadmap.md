# Taek Shops — Implementation Roadmap

Small, independently testable phases. A phase is **Complete** only when every
acceptance criterion is implemented **and verified** by the stated checks. No
phase may be marked complete on the basis of scaffolding alone.

**Verification pipeline** (run for every phase):
`npm ci` → `npm run format:check` → `npm run lint` → `npm run typecheck` →
`npm run test` → `npm run build`. Add `npm run test:e2e` from Phase 3 on and
`npm run test:integration` from Phase 5 on. From Phase 5, `test:integration`
needs a database; from Phase 6, `test:e2e` does too (the storefront reads it) —
`docker compose up -d && npm run db:deploy && npm run db:seed` first.

Legend: ✅ Complete · 🚧 In progress / awaiting review · ⬜ Not started

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

## Phase 3 — Authentication, authorization & audit ✅ _(live pre-flight verified 2026-09-03)_

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
- [x] **Verified in the Phase 5 pre-flight against live PostgreSQL (2026-09-03):**
      `migrate deploy` applied all three migrations to a clean database; the
      optional admin seed creates one `ADMIN`/`ACTIVE` user with an Argon2id
      hash and is idempotent (no password rotation on re-run); the full
      sign-in → session → logout loop was exercised end-to-end over HTTP
      (pre-login 401 → bad-password 401 → login 200 + `lastLoginAt` set →
      session reports the user → admin API 200 → logout 200 → session cleared →
      admin API 401), with `AuditLog` rows for `auth.login.failed`,
      `auth.login.succeeded`, `auth.logout`. Verified manually; an **automated
      e2e for the authenticated flow is deferred to Phase 5** (lands with the
      DB-backed integration suite).

**Deferred to Phase 4+:** real email transport; shared-store rate limiter;
customer self-registration UI; account-settings UI; brute-force lockout counter;
tightening `style-src` off `'unsafe-inline'`.

---

## Phase 4 — Catalogue, inventory, admin management & import foundation ✅ _(live pre-flight verified 2026-09-03)_

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
- [x] **Verified in the Phase 5 pre-flight against live PostgreSQL (2026-09-03):**
      `migrate deploy` applied `20260905000000_phase4_catalog` (both unique
      indexes — `ProductVariant_sku_key`, `ProductVariant_productId_optionSignature_key`
      — confirmed present); seed populates 1 product / 4 variants with distinct
      option signatures and is idempotent across repeated runs; a live inventory
      adjustment wrote a `StockMovement` + `inventory.adjusted` `AuditLog` and an
      oversell attempt was rejected (409) with on-hand unchanged; a CSV import
      round trip ran preview (zero catalogue writes) → commit (2 products
      created, row-level error isolation, no partial write) → re-import of the
      same file (created 0 / skipped 2, no new rows) = idempotent;
      formula-injection payloads were neutralised then rejected; in-file
      duplicate SKU and duplicate option combination were both rejected.
      **Seed defect found and fixed during this pre-flight:** `prisma/seed.ts`
      never set `ProductVariant.optionSignature`, so all four demo variants
      collided on the new unique constraint — fixed in commit `2537d32`.
- [ ] Storefront pages, faceted filtering UI, accessibility/perf budgets — not in
      this phase's scope (public query layer is done and tested).

---

## Phase 5 — Inventory (hardening) 🚧 _(awaiting CTO review, 2026-09-03)_

Full design: [`docs/catalog.md`](catalog.md) § "Concurrency & the ledger
invariant" and [`src/server/orders/README.md`](../src/server/orders/README.md).

**Scope (delivered)**

- **Row locking** (`src/server/inventory/inventory-lock.ts`) — every stock
  mutation opens a transaction and takes `SELECT … FOR UPDATE OF "InventoryItem"`
  before reading counters. Parallel writers to the same variant serialize;
  overselling and lost updates are impossible under READ COMMITTED.
- **Two-column ledger** — `StockMovement.reservedDelta` added alongside
  `quantityDelta`, so **both** counters reconcile against the append-only ledger
  (`quantityOnHand == SUM(quantityDelta)`,
  `quantityReserved == SUM(reservedDelta)`). `src/server/inventory/invariant.ts`
  recomputes and reports drift; surfaced at `GET /api/admin/inventory/health`.
- **Database CHECK constraints** on `InventoryItem` (on-hand ≥ 0, reserved ≥ 0,
  reserved ≤ on-hand) — a backstop under the application rules.
- **Idempotent movements** — `StockMovement.idempotencyKey` (unique); the order
  primitives pass `order:<id>:<op>:<variantId>` so a replayed operation is a
  no-op, never a duplicate movement.
- **Order lifecycle wiring** (`src/server/orders/order-inventory.ts`) —
  `reserveOrderStock` / `commitOrderStock` / `releaseOrderStock` /
  `restockOrderStock`, each atomic across all lines, deadlock-free
  (ascending-`variantId` lock order), authorized (`order.write`).
  `applyOrderStatusTransition` validates an `OrderStatus` transition against a
  small state machine and applies the matching inventory effect + status write
  in one transaction. Order _creation_ stays Phase 6; the full state machine
  stays Phase 8.
- Additive migration `20260906000000_phase5_inventory` (2 columns, 1 unique
  index, 3 CHECK constraints). No Phase 2–4 model altered.
- **Pre-work resolved:** `output: "standalone"` dropped from `next.config.ts`
  (re-added in Phase 13 with the matching container start command) — removes the
  `next start` warning; the authenticated sign-in → session → logout flow is now
  an automated e2e (`tests/e2e/auth-session.spec.ts`, runs with
  `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD`). `npm ci` in CI stays open (no CI
  config exists yet — Phase 13).

**Deferred:** wiring these operations into an actual checkout / payment / refund
flow (Phases 6–8); the `onHand` reconciliation as a scheduled job.

**Acceptance criteria**

- [x] Concurrent reservation cannot oversell — 50 parallel single-unit
      reservations against 20 on-hand: exactly 20 succeed, 30 fail cleanly,
      counter + ledger both land on 20
      (`tests/integration/inventory-concurrency.integration.test.ts`).
- [x] `onHand` == sum of movements — holds after **every** step of a
      200-operation randomized sequence, and `reserved == SUM(reservedDelta)`
      too; out-of-band corruption is detected
      (`tests/integration/inventory-invariant.integration.test.ts`).
- [x] Safe transaction semantics for receive / adjust / reserve / release /
      commit / restock (`tests/integration/inventory-transactions.integration.test.ts`).
- [x] reserve/release/commit/restock wired into order placement + status
      transitions; atomic, idempotent, no partial reserve
      (`tests/integration/order-inventory.integration.test.ts`).
- [x] Negative inventory, overselling, duplicate movements, race corruption, and
      inconsistent `onHand` are all prevented (unit + integration + DB CHECK).
- [x] `lint`, `typecheck`, **193** unit tests, **27** integration tests, **14**
      e2e (+1 authenticated e2e that runs with seed creds), `next build`,
      `prisma validate` / migration idempotency — all green against live
      PostgreSQL.
- [x] Phase 1–4 behaviour preserved (all prior tests green; no Phase 2–4 model
      changed).

---

## Phase 6 — Cart & checkout (no real payment) 🚧 _(awaiting CTO review, 2026-09-03)_

Design: [`docs/architecture.md`](architecture.md) §9–§12,
[`src/server/orders/README.md`](../src/server/orders/README.md).

**Scope (delivered)**

- **Cart** (`src/server/cart/`) — guest (opaque `taek_cart` cookie token) +
  customer; one `ACTIVE` cart per token. `getCartSummary` recomputes every line
  from the current `ProductVariant.priceCents` and drops no-longer-sellable
  lines. Quantity clamped to 99.
- **Tax** (`src/server/tax/`) — `TaxCalculator` interface +
  `ConfiguredRateTaxCalculator` reading `TaxRegion`/`TaxRate` (province match →
  country-wide fallback; `taxCategory` filter; `priority`; `compound`;
  effective-date window). `taxCents = round(taxableCents * rate)`.
- **Shipping** (`src/server/shipping/`) — `ShippingRateProvider` interface +
  `FlatRateShippingProvider` reading `ShippingZone`/`ShippingZoneRegion`/
  `ShippingMethod`, with `freeShippingThresholdCents`.
- **Checkout** (`src/server/orders/checkout-service.ts`) — `quoteCheckout`
  (read-only review) + `placeOrder`: one transaction that recomputes all
  amounts server-side, creates the `Order` (`PENDING`/`UNPAID`) + `OrderItem`
  snapshots + `OrderAddress` (shipping & billing) with frozen totals, reserves
  stock via the Phase 5 `reserveStockTx`, and converts the cart. Idempotent on
  `Order.cartId`.
- **Storefront** (`src/app/(storefront)/`) — product grid, product page with
  add-to-cart, cart page, checkout page (address + shipping + live review),
  order-confirmation page. The minimum surface to exercise cart → checkout; full
  catalogue browsing / faceting is still later work.
- Audit action `order.placed`. **No schema change** — the Phase 2 models
  (`Cart`, `Order`, `TaxRegion`, `ShippingMethod`, …) already cover it.

**Out of scope (deferred, unchanged):** real payment / Stripe → Phase 7; the
tax & shipping **configuration admin UI** → Phase 11 (Phase 6 consumes the
tables + seed example rows); order management / customer order history / status
machine beyond `PENDING` → Phase 8; discount codes (`discountCents` stays 0).

**Acceptance criteria**

- [x] Client cannot alter prices/totals — the input schema has no money fields,
      hostile extras are stripped, and `placeOrder` recomputes every amount from
      the catalogue + config (unit `checkout-service` + integration
      `checkout` "ignores any client-supplied money fields").
- [x] Tax and shipping are quoted from configured data and frozen onto the order
      — integration test asserts `order.taxCents` (13% HST), `order.shippingCents`
      ($12 flat / $0 over the free-shipping threshold), and the per-line
      `lineTaxCents` against the seeded ON/HST + Canada/Standard rows.
- [x] Order creation + stock reservation is atomic — integration test: an
      under-stocked line places **no** order, reserves **nothing**, leaves the
      cart `ACTIVE`; a concurrent race for the last units yields exactly one
      order and never oversells.
- [x] e2e: cart → checkout → order in `pending` state
      (`tests/e2e/checkout.spec.ts`, live PostgreSQL via `global-setup.ts`).
- [x] `lint`, `typecheck`, **211** unit, **36** integration, `next build`,
      **16** e2e (+1 seed-gated), all green.

---

## Phase 7 — Payments (Stripe) 🚧 _(awaiting CTO review, 2026-09-03)_

Design: [`docs/architecture.md`](architecture.md) §10,
[`src/server/domain/payments/README.md`](../src/server/domain/payments/README.md).

**Scope (delivered)**

- **`PaymentGateway` interface** (`src/server/domain/payments/payment-gateway.ts`)
  - **`StripePaymentGateway`** (`stripe.ts`): `createPaymentIntent` (always with a
    per-request idempotency key), `retrievePaymentIntent`, `parseWebhook`
    (signature-verified via `STRIPE_WEBHOOK_SECRET`), `refund` (passthrough; order
    effects are Phase 8). Card data never crosses this boundary.
- **`startPayment`** (`src/server/orders/payment-service.ts`) — creates/reuses
  **one** `Payment` row + PaymentIntent per order (`Payment.@@unique([orderId])`
  - Stripe `pi-create-<orderId>` idempotency key ⇒ no duplicate charge). The
    amount is always `Order.totalCents` (frozen at checkout) — the client supplies
    nothing.
- **Stripe Payment Element** on the client
  (`src/app/(storefront)/checkout/[orderNumber]/payment`), confirming with a
  `return_url` back to `…/complete`.
- **Webhook** `POST /api/webhooks/stripe` — invalid/missing signature → 400,
  nothing written. Every event id recorded in `WebhookEvent` (unique `eventId`)
  **inside** the processing transaction ⇒ redelivery / replay / duplicate is a
  no-op and two concurrent deliveries race on the insert. `payment_intent.succeeded`
  → `Payment CAPTURED`, `Order.paymentStatus PAID`, and `PENDING → CONFIRMED`
  which **commits** the Phase 5 reservation (once). `payment_intent.payment_failed`
  / `.canceled` → `Payment FAILED`, `Order.paymentStatus FAILED`, and
  `PENDING → CANCELLED` which **releases** the reservation. Out-of-order events
  are absorbed by order-state guards (no double commit, no invalid transition).
- **Server-side completion only** — `…/complete` calls `verifyPaymentStatus`
  which retrieves the intent from Stripe and runs the same idempotent finalize;
  the browser's `redirect_status` is never trusted.
- Amount/currency are re-verified against the frozen order on every finalize.
- CSP updated for Stripe.js (`connect-src api.stripe.com`, `frame-src
js.stripe.com hooks.stripe.com`). Additive migration
  `20260907000000_phase7_payments` (`WebhookEvent` + `Payment.@@unique([orderId])`).

**Acceptance criteria**

- [x] Stripe test-mode payment moves an order `pending → paid` and commits stock
      — server layer verified end-to-end
      (`tests/integration/payments.integration.test.ts`: signed
      `payment_intent.succeeded` through the real webhook route → order
      CONFIRMED/PAID, one SALE movement, ledger reconciles). **The browser
      card-entry leg needs a Stripe test account — see "external verification".**
- [x] Failed payment releases reserved stock — integration test:
      `payment_intent.payment_failed` → order CANCELLED/FAILED, reservation
      released, ledger reconciles.
- [x] Webhook replay / duplicate event is a no-op — integration test: 3×
      redelivery + 3× concurrent delivery → exactly one SALE movement, on-hand
      unchanged after the first.
- [x] Unsigned / badly-signed / tampered webhook rejected — unit
      (`stripe-webhook-signature.test.ts`, real crypto) + integration + e2e.
- [x] No PAN/CVV/expiry persisted anywhere — the `Payment.metadata` stores only
      card brand + last4; card data is entered into Stripe's iframe and never
      posted to this server (code + schema review in the Phase 7 report).
- [ ] **e2e checkout with Stripe test card passes in CI** — blocked: needs a
      Stripe TEST account, test keys as CI secrets, and `stripe listen` webhook
      forwarding. The checkout → payment routing and the webhook signature gate
      are verified locally (`checkout.spec.ts`, `payment.spec.ts`).
- [x] `lint`, `typecheck`, **230** unit, **45** integration, `next build`,
      **18** e2e (+1 seed-gated) — all green.

**Deferred unchanged:** refund orchestration + order state machine (Phase 8);
retry of a declined card on the same order (a failed payment cancels the order,
per the roadmap "failure → cancelled + release").

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
