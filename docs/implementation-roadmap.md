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

## Phase 8 — Order management 🚧 _(admin-order scope: CTO sign-off 2026-09-17 — phase not complete)_

**Scope delivered this increment** (`src/server/orders/order-management-service.ts`,
`src/app/admin/orders/`) — **admin side only**, reusing the Phase 5 inventory
machinery unchanged:

- Admin order list (`/admin/orders`: search by order number/email, filter by
  order/payment/fulfilment status, sort, pagination) and detail
  (`/admin/orders/[id]`: items, prices at purchase, totals, addresses, redacted
  payment history).
- `OrderStatus` transitions via a new admin-allowed subset
  (`ADMIN_ORDER_STATUS_TRANSITIONS`) layered in front of the existing,
  unmodified `applyOrderStatusTransition` — `PENDING → CONFIRMED` (payment
  success) is excluded from the admin-allowed set on purpose, so a status
  change can never stand in for a real Stripe payment.
- `FulfillmentStatus` (shipping tracker) wired up for the first time:
  `UNFULFILLED → PARTIALLY_FULFILLED/FULFILLED → RETURNED`, gated on
  `paymentStatus === PAID`, independent of `OrderStatus`. **Purely
  informational — never touches inventory** (stock already moved at
  reserve/commit time).
- One additive audit constant, `order.fulfillment_status.changed`. **No schema
  change.**

**Not part of this increment** (still open against the original scope below):
refund via `PaymentGateway.refund` + stock return movements; transactional
emails. These remain unstarted. **Customer-facing order history/detail was
delivered in a later pass the same day** — see "Customer order history"
below.

**Manual verification (user-reported, 2026-09-17, existing admin account —
role-restriction behaviour and other actions were NOT exercised and are not
implied verified):**

- `/admin/orders` displayed the order list.
- Order detail opened successfully for a real order.
- The order initially showed `Confirmed` / `Paid` / `Unfulfilled`.
- Clicking "Start Processing" moved it to `Processing`; a browser refresh
  confirmed `Processing` / `Paid` / `Unfulfilled` persisted (i.e. the write
  landed and `paymentStatus` was untouched by the order-status action, as
  designed).

**Original scope** (unchanged, restated for when refunds/customer UI/email land):

- Admin order list/detail; state machine
  (`paid → fulfilled → completed`, `cancelled`, `refunded`).
- Refund via `PaymentGateway.refund`; stock return movements.
- Customer order history + order detail.
- Transactional emails (confirmation, shipped) behind a `Mailer` interface.

**Automated verification (this validation pass, 2026-09-17)** — separate from,
and in addition to, the human-reported manual check above:

- `npm run build` (Turbopack production build): **failed on first attempt** —
  pre-existing corrupted persistent Turbopack cache
  (`.next/cache/turbopack/…`, a gitignored build artifact, unrelated to
  Phase 8 or any application code: `TurbopackInternalError: Failed to lookup
  task ids … Unable to open static sorted file`). Cleared only that cache
  subdirectory (no source, no business data) and rebuilt: **passed** —
  `/admin/orders` and `/admin/orders/[id]` both compile as dynamic routes
  alongside every existing route, no errors.
- `npm run test:integration`, filtered to the new
  `tests/integration/order-management.integration.test.ts`, against
  `TEST_DATABASE_URL` (the fail-closed isolation check in
  `tests/integration/helpers/setup.ts` passed, confirming a genuinely
  separate database before any test ran): **9/9 passed**. Real Prisma, real
  `order-management-service.ts` (not copied/reimplemented logic), namespaced
  fixtures (`zzz-phase8-*` / `PF8-*`, cleaned up in `afterAll`). Coverage:
  unauthenticated/CUSTOMER denied on every read and write, STAFF denied
  writes, MANAGER can read and write; `PENDING → CONFIRMED` blocked and the
  order left untouched in the database; an unrelated illegal transition
  blocked; a legal transition (`CONFIRMED → PROCESSING`) persists, leaves
  `paymentStatus` untouched, and writes an `order.status.changed` audit row
  with the correct `from`/`to`; cancelling a PENDING order with a real
  variant releases its reservation through the real service; fulfilment is
  refused on an unpaid order and on a cancelled order; a valid fulfilment
  change on a PAID order persists, writes an `order.fulfillment_status.changed`
  audit row, and leaves the variant's `InventoryItem` and `StockMovement`
  count byte-for-byte unchanged.
- `npm run test:e2e`: previously **NOT RUN — blocked** (see prior note, kept
  below for history). **Fixed and now run, 2026-09-17 (second pass):**
  - **Isolation fix**: `playwright.config.ts` now runs a dedicated server on
    **port 3100** (never 3000), `reuseExistingServer: false` always,
    `workers: 1` / `fullyParallel: false` (fixtures are shared and mutated —
    never run concurrently). It requires and statically verifies
    `TEST_DATABASE_URL` at config-load time and passes it explicitly into the
    spawned server's `env`. `tests/e2e/global-setup.ts` independently
    re-verifies isolation with a **live** connection reading Postgres's own
    `current_database()` (mirrors `tests/integration/helpers/setup.ts`),
    fails closed otherwise. `next.config.ts` gained `distDir:
    process.env.E2E_DIST_DIR || ".next"` so this run's `next build` writes to
    `.next-e2e` instead of the `.next` a concurrently-running `next dev` is
    using (a shared dist dir corrupted the dev server's Turbopack cache once
    already this session).
  - **Fixture safety**: new Phase 8 fixtures (3 login-capable users, 3
    orders) are tagged with a run id unique per invocation and cleaned up by
    **exact** email/order-number match, never a shared prefix. (The
    pre-existing Phase 6/7 checkout fixtures were left logically unchanged —
    out of this task's scope — just now pointed at the isolated database
    instead of the app's own.) Login goes through the real `/login` form
    with real Argon2id-hashed test-only accounts — no session fabrication.
    No Stripe or email code path is reachable from any Phase 8 spec.
  - **Bug found and fixed**: the run id was first generated with
    `randomBytes()` at module top level, shared between `global-setup.ts` and
    `admin-orders.spec.ts` via import — but Playwright runs `globalSetup` in
    the main process and spec files in a separate worker process, so the
    spec re-executed the random generation and got a **different** id than
    what was actually written to the database (every login failed,
    "unknown user"). Root-caused via a real, isolated diagnostic (an
    in-process auth check against the test DB, then a manual curl against a
    hand-launched instance of the same server config) before touching any
    code. Fixed by generating the id once in `global-setup.ts` and persisting
    it to a temp file that the spec reads
    (`tests/e2e/helpers/phase8-fixtures.ts`).
  - **Result: 5/5 passed** (`tests/e2e/admin-orders.spec.ts`, 52.5s) — list
    search/filter/sort against predictable fixtures; order detail (items,
    totals, shipping address); `Confirmed → Processing` persisting after a
    real `page.reload()` with `paymentStatus` unchanged; CUSTOMER denied
    admin access (`Access denied`, no order table); STAFF sees the order but
    no status-change controls. Teardown verified to leave **zero** residual
    Phase 8 rows in the test database; the application's own dev database
    was independently confirmed untouched (0 e2e rows, order count
    unchanged) and `localhost:3000` / the Stripe CLI listener were never
    stopped or reused.
- `tsc --noEmit` and `eslint`: clean on every file this pass touched
  (`next.config.ts`, `playwright.config.ts`, `tests/e2e/**`,
  `tests/integration/order-management.integration.test.ts`).
  `npm run test` (unit) was **not** rerun this pass, per instruction (no
  unrelated full suites); last known result stands at 300/300.

**Acceptance criteria**

- [x] Order-status and fulfilment-status transitions are validated and
      audit-logged — unit-tested (18, mocked Prisma), integration-tested (9,
      isolated real database, real service, real audit rows), **and** now
      e2e-tested for the `Confirmed → Processing` path through the real UI.
- [x] STAFF-vs-MANAGER authorization and admin order list/detail/search/
      filter/sort are now verified end-to-end in a real browser against a
      dedicated, isolated server and database (5/5 e2e), in addition to the
      one human-verified transition recorded above (that entry is kept as
      the original manual record, not overwritten by this automated run).
- [x] Refund updates order, payment, and inventory consistently (integration
      test) — implemented 2026-09-18, reviewed and hardened over two
      follow-up passes (see "Refund workflow" below), and confirmed
      **inventory-consistent by design, not merely by omission**: a refund
      updates only `Refund`/`Payment.refundedCents`/`Payment.status`/
      `Order.paymentStatus` — it never touches `InventoryItem`,
      `StockMovement`, `Order.status`, or `FulfillmentStatus` (a dedicated
      integration test asserts stock/reservation/movement history
      byte-for-byte unchanged after a refund). Verified against real Stripe
      **Test Mode** with two live manual refunds (2026-09-23 — see below), on
      top of the automated suite.
- [x] Customer sees only their own orders (authz test) — delivered
      2026-09-17 (`listMyOrders`/`getMyOrderDetail`, strict
      `userId`-ownership, 404-not-403 on mismatch, no guest-order-by-email
      leakage): **9/9** integration + **3/3** e2e, both reconfirmed passing
      in the full, unfiltered regression run below. The admin `order.read`
      gate remains separately unit-, integration-, and e2e-tested.
- [x] Full verification pipeline green — **verified 2026-09-23**, full
      suites, no Phase-8 filter: unit **320/320** (43 files), integration
      **105/105** (13 files, isolated `TEST_DATABASE_URL`), e2e **29/29**
      (dedicated port-3100 harness, isolated database) — see "Full
      regression + manual Stripe Test-Mode refund verification" below for
      detail. `lint`/`typecheck` clean.

**CTO sign-off (2026-09-17) — admin-order scope only:** approved on this
evidence: production build passed; 9/9 focused integration tests passed
(isolated `TEST_DATABASE_URL`); 5/5 isolated browser tests passed
(dedicated port/database, real login flow); the `Confirmed → Processing`
transition was additionally verified manually by the user, persisting after
a browser refresh. This sign-off covers only the admin order list/detail and
status/fulfilment workflow delivered above. **Phase 8 as a whole, and the
project, remain incomplete** — refunds, customer-facing order history, and
transactional emails are still deferred/unimplemented (not built this
increment, not part of this sign-off).

**Pre-release regression task — COMPLETE (2026-09-17):** every legacy e2e
spec was reviewed for assumptions the new isolated harness breaks (ports,
base URLs, auth, fixture ids, env loading, DB access), adapted where broken,
and run.

- **Found & fixed**: three specs (`catalog.spec.ts`, `auth.spec.ts`,
  `auth-session.spec.ts`) hand-built a `request.post(...)` with a hardcoded
  `Origin: http://localhost:3000` header for the same-origin CSRF check
  (`src/lib/http/csrf.ts`) — wrong now that the suite runs on port 3100; two
  of the three tests would have kept returning 403 for the *wrong* reason
  (origin mismatch instead of the intended "missing CSRF token"). Fixed by
  extracting a shared `E2E_ORIGIN` constant
  (`tests/e2e/helpers/base-url.ts`), used by these specs and by
  `playwright.config.ts` itself (single source of truth for the port).
  `checkout.spec.ts`, `payment.spec.ts`, `smoke.spec.ts`,
  `variant-picker.spec.ts` needed no changes — relative navigation/fetches
  and the existing `global-setup.ts` fixtures (now pointed at the isolated
  database) already worked correctly.
- **`auth-session.spec.ts` — completed 2026-09-17 (second pass):** the
  `db:seed`-admin dependency (incompatible with the isolated database — that
  account lives in the *application's* database, never `TEST_DATABASE_URL`,
  and seeding the test database is explicitly out of scope) is gone. It now
  signs in as a dedicated MANAGER account (`authSessionEmail`, real
  Argon2id hash) created only in `TEST_DATABASE_URL` by `global-setup.ts`,
  cleaned up by exact email match alongside the Phase 8 accounts. The
  `test.skip(...)` env-var gate was removed only after this real prerequisite
  existed — every original assertion (CSRF bootstrap, pre-login 401,
  wrong-password 401, correct-password 200 + session, `/api/admin/users`
  200→401, `/api/admin/inventory/health` <500, logout revoking the session)
  is unchanged, none weakened.
- **Result**: **25 passed, 0 skipped, 0 failed** — the full `tests/e2e/`
  directory: all 6 non-admin-order specs (now including `auth-session`) plus
  the 5 Phase 8 specs (rerun because the shared `global-setup.ts` /
  `phase8-fixtures.ts` changed).
- **Payment coverage — real vs. mocked**: `payment.spec.ts`'s two tests are
  genuine, not mocked — a real POST to the real `/api/webhooks/stripe` route
  with an unsigned and a badly-signed payload, both correctly rejected
  (`[stripe-webhook] rejected: …` logged by the real handler), and a real
  404 for a nonexistent order's payment page. Neither test drives a real
  Stripe test card through the Payment Element — that has never been
  automated here (pre-existing scope, per the file's own header comment: it
  requires a Stripe **test account** + CI-managed test keys + webhook
  forwarding, "see the Phase 7 report") and remains **explicitly out of
  scope**, not silently replaced by anything mocked. No Stripe network call
  of any kind occurred.
- **Isolation held throughout (both passes)**: test database confirmed empty
  of every fixture (Phase 8, auth-session, checkout/multivariant) after
  teardown; the application's dev database independently confirmed unchanged
  (0 e2e rows, order count stable at 7 before/after both runs);
  `localhost:3000` returned 200 throughout and was never reused; the Stripe
  CLI listener's PID/start-time were unchanged; nothing was left listening on
  3100/3101 after either run.
- **Files changed — first pass**: `playwright.config.ts`,
  `tests/e2e/auth.spec.ts`, `tests/e2e/catalog.spec.ts`,
  `tests/e2e/helpers/base-url.ts` (new). **Second pass (auth-session)**:
  `tests/e2e/auth-session.spec.ts` (rebuilt on a test-owned account, skip
  removed), `tests/e2e/global-setup.ts` (renamed
  `create/cleanupPhase8Fixtures` → `create/cleanupLoginFixtures`, added the
  one extra MANAGER user + its cleanup), `tests/e2e/helpers/phase8-fixtures.ts`
  (added `authSessionEmail`). No application code changed either pass, so no
  new production build was required (the isolated build already runs as part
  of the e2e webServer). `tsc --noEmit` and `eslint` clean on every changed
  file, both passes.

### Customer order history — delivered 2026-09-17, coverage reconfirmed 2026-09-23

**Scope delivered**: authenticated customer-facing order history, read-only,
following the existing storefront route/query conventions:

- `GET /account/orders` — the signed-in user's own orders, newest first,
  paginated (10/page): order number, date, total, currency, payment/order/
  fulfilment status. Empty state when there are none.
- `GET /account/orders/[orderNumber]` — item snapshots (product/variant name,
  SKU, quantity, unit price at purchase — never a live catalog price),
  subtotal/discount/shipping/tax/total, and the shipping address. No
  `Payment` row, provider id, or audit data is queried or rendered.
- `listMyOrders` / `getMyOrderDetail` (`src/server/orders/order-queries.ts`) —
  new, strict-ownership-only queries: `requireUser` (401/redirect if absent),
  `where: { userId: authed.id }` for the list, and `order.userId !==
  authed.id` → **404, not 403** for the detail (mirrors the existing
  `getOrderForConfirmation`'s "never disclose existence" rule) — deliberately
  **no staff bypass and no "just placed" bypass**, unlike that function,
  because this is the customer's own permanent history, not a one-time
  post-checkout confirmation. A guest order (`userId` null) can never appear
  here, including when its `customerEmail` happens to match the signed-in
  user's own email — nothing in this feature attaches a guest order to an
  account by email, on purpose.
- One new nav link, "My orders" (`src/app/(storefront)/layout.tsx`), shown
  only when a user is signed in.
- **No schema change**, **no refund/cancel/reorder/email affordance**, **no
  inventory interaction** — read-only exactly as scoped.

**Tests**:
- `tests/integration/customer-order-history.integration.test.ts` — **9/9
  passed**, isolated `TEST_DATABASE_URL`, real service functions. Covers:
  unauthenticated rejection (both functions); empty history; list scoped to
  exactly the caller's own orders (a second customer's order and a
  `userId: null` guest order under the *same* email both excluded);
  pagination; detail returns the purchase-time snapshot (not any live price);
  detail 404s for another customer's order and for a guest order matching by
  email (both `NotFoundError`, never a 403); 404 for a nonexistent order
  number.
- `tests/e2e/customer-order-history.spec.ts` — **3/3 passed**, dedicated e2e
  server + isolated database, real `/login` flow, two real test-owned
  customer accounts + a third with no orders. Covers: unauthenticated
  redirect to `/login?next=/account/orders`; a customer's own list/detail
  rendering correctly, a second customer's order 404ing by number guess, and
  the nav link appearing once signed in (all folded into one test after one
  login — see the file's own comment: the production login rate limiter,
  10 attempts/15 min keyed partly by IP, is shared across every spec file in
  one e2e run, and was hit and fixed as a **real, reproducible flake** this
  pass by reducing redundant logins, not by touching the limiter); empty
  state for a fresh customer.
- Full regression: unit **300/300**, integration (whole suite, not just this
  feature) **83/83** across 12 files, e2e (whole suite) **28/28** — all
  rerun this pass since shared fixture/helper files changed.
- `tsc --noEmit` and `eslint` clean on every changed/new file.
- **Production build**: passed (`next build`, dev server stopped first,
  restarted after — confirmed serving again, Stripe CLI listener's PID/start
  time unchanged throughout). `/account/orders` and
  `/account/orders/[orderNumber]` compile as dynamic routes.
- Dev database independently confirmed unchanged (0 leaked e2e rows, order
  count stable at 7) after every run this pass.

**Manual review URL**: `http://localhost:3000/account/orders` (requires
signing in as a real account — no dev-seeded credentials were used or
printed this pass).

**Not claimed**: automated real-Stripe checkout coverage remains
unverified/unautomated (unchanged, out of scope). Refunds, transactional
emails, and reorder are still deferred/unimplemented. This subsection is new
evidence, not a CTO sign-off — Phase 8 as a whole remains **not signed off**
and the project remains incomplete.

**Post-checkpoint manual observation (2026-09-18):** user reported that after
the above pass, clicking a paid order's number on `/account/orders`
"appeared to remain loading." Not documented at the time; treated as neither
a confirmed regression nor resolved. Environment was found fully down
(Docker Desktop stopped, dev server not running) and was restored
non-destructively (no reset/seed/migrate) before any diagnosis. Code review
of `getMyOrderDetail`/`listMyOrders` and both page components found no
defect and no `paymentStatus`-dependent branching. **Root cause not
confirmed** — no error was reproduced either before or after restoring the
environment, so this is not attributed to any specific cause (dev-mode
first-compile latency remains a plausible but unproven explanation).
**User-confirmed manual success (2026-09-18, same day, restored
environment):** the paid order's detail page opened and displayed product,
size, quantity, and total. Server log for that exact request: `GET
/account/orders/TS-20260917-749CT2 200 in 1970ms` — clean 200, no error, no
worker exception, no panic. No code change was made or needed for this.

**Refund workflow (implemented 2026-09-18, under review — not signed off).**
MANAGER/ADMIN-only refund requests (`src/server/orders/refund-service.ts`,
`src/app/admin/orders/[id]/refund-panel.tsx`): row-lock-serialized balance
reservation (captured − confirmed-refunded − pending-refunded, PENDING and
ambiguous refunds both reserve), caller-supplied idempotency key with
deadlock-retried creation, `PaymentGateway.refund`/`retrieveRefund` +
signature-verified `refund.updated` webhook reconciliation, audit logging,
inventory/fulfillment untouched. Migration
(`prisma/migrations/20260918214737_phase8_refunds/`) is additive-only (1
enum, 1 table, 4 indexes, 2 FKs — no `ALTER`/`DROP` on existing tables) and
is **applied only to the isolated test database**, never the dev database.

Two review passes fixed concrete gaps found against official Stripe
documentation and closer reading of the concurrency/config paths, before any
real Stripe Test-Mode call was ever made:

- _Ambiguous-outcome webhook linkage._ A `refund.updated` event arriving
  before a `providerRefundId` was known locally (the network/timeout case)
  used to silently no-op. Fixed by attaching `metadata:{taekShopsRefundId}`
  on Stripe's `refunds.create` (confirmed supported via
  `docs.stripe.com/api/refunds/create`) and a verified fallback lookup in
  `reconcileRefundFromEventTx` (checks the candidate row is still PENDING
  and that amount/currency/payment-intent all match before applying
  anything).
- _Retry safety past Stripe's idempotency window._ Stripe only guarantees an
  idempotency key for a **minimum of 24h**
  (`docs.stripe.com/api/idempotent_requests`); `reconcileRefund` used to
  retry indefinitely. Fixed with a 12h safe-retry cutoff, past which it
  refuses and requires manual reconciliation instead.
- _Retry parameter fidelity (verified, not just fixed)._ Confirmed by code
  audit that `Refund.amountCents`/`idempotencyKey` and
  `Payment.providerPaymentId` are never mutated after creation anywhere in
  the codebase, so `reconcileRefund`'s reconstructed retry request is always
  byte-identical to the original — proven end-to-end (not just by
  inspection) by teaching the integration test double to reject a reused key
  sent with different parameters, exactly like real Stripe does, and
  confirming the actual retry path never trips it. Added a defensive check
  that refuses to retry (rather than guess) if a payment's provider
  reference were ever missing.
- _E2E fake-gateway isolation, hardened twice._ First pass required
  `PAYMENT_GATEWAY=e2e-fake` + `E2E_DIST_DIR` but only **logged and fell
  back** on a partial/inconsistent signal. Second pass changed this to
  **throw** before any gateway is constructed (a silent fallback to real
  Stripe on a broken e2e config is worse than a loud failure), requires an
  **exact** `E2E_DIST_DIR` match (not merely truthy), and independently
  verifies `DATABASE_URL === TEST_DATABASE_URL` at runtime — actual proof of
  database routing, not just a configuration marker — since Playwright's
  `webServer.env` inherits the launching process's own environment
  (confirmed via `playwright.dev/docs/test-webserver`), making
  `TEST_DATABASE_URL` independently visible inside the spawned e2e server
  process. **Residual risk, stated honestly:** this proves `DATABASE_URL`
  was routed to whatever `TEST_DATABASE_URL` resolves to in that process; it
  does not itself re-verify that `TEST_DATABASE_URL` is a genuinely
  different database from the real one by connecting live — that
  verification remains `tests/e2e/global-setup.ts` / `playwright.config.ts`'s
  `requireIsolatedE2eDatabase()`'s job, and an operator who set
  `TEST_DATABASE_URL` equal to the real `DATABASE_URL` in `.env` would defeat
  both guards identically.

**Test evidence:** unit 4 files/34 tests, integration
`refund.integration.test.ts` 22/22 (authorization, full/partial, over-refund
rejection, idempotent double-click, different-key concurrency with a
gateway-call-count spy proving the loser never reaches the provider,
PENDING/ambiguous balance reservation, provider failure/pending/ambiguous
outcomes, webhook settle/duplicate/stale-out-of-order/metadata-fallback,
retry-window refusal, retry-parameter-fidelity, inventory untouched),
`payments.integration.test.ts` (Phase 7, shared gateway swap point) 9/9
unaffected. `tsc --noEmit` and `eslint` clean on every touched file. E2E
`admin-refund.spec.ts` **1/1 passed** against the dedicated isolated harness
(port 3100, its own `taek_shops_test` database, `PAYMENT_GATEWAY=e2e-fake`)
after the gateway-guard and metadata changes: a MANAGER requests a $15.00
partial refund through the real admin UI, it settles immediately via the
fake gateway, and after a page reload the SUCCEEDED status, the $15.00
refunded figure, and the $25.00 remaining-balance figure are all still
correctly persisted and displayed (inventory-unchanged is covered by the
integration suite's dedicated test, not this spec — its fixture has no
inventory item). Dev server (port 3000) and Stripe CLI listener confirmed
still running, untouched, throughout both review passes. No real Stripe call
was made at any point; the dev database was never migrated.

**Not claimed (as of the review pass above)**: no real Stripe Test-Mode
refund has been exercised yet; Phase 8 as a whole remains **not signed off**
and the project remains incomplete.

**Dev database migration applied (2026-09-18).** After the review pass
above, `20260918214737_phase8_refunds` was applied to the actual local
development database (`taek_shops` on `localhost:5432`) — confirmed the
correct target from `DATABASE_URL` first, and confirmed it was the ONLY
pending migration (`prisma migrate status`) with the exact additive SQL
already reviewed (1 enum, 1 table, 4 indexes, 2 FKs — no `ALTER`/`DROP`).

- **Backup**: a timestamped `pg_dump -Fc` archive was taken via `docker exec`
  into the running `taek-shops-postgres` container and copied out to this
  session's scratchpad directory (outside the repo, outside version
  control, not printed here). Verified readable/listable with `pg_restore
  --list` (269 archive entries, expected pre-migration table set, no
  `Refund` table yet) before proceeding.
- **Baseline preserved**: read-only aggregate counts recorded before and
  re-checked after migration — `Order` 7, `Payment` 7, payment amount sum
  40485¢, payment refunded sum 0¢, `CAPTURED` 5 / `PARTIALLY_REFUNDED` 0 /
  `REFUNDED` 0, `InventoryItem` 36 rows / 71 total qty on hand, `AuditLog` 54
  — byte-identical before and after. No refund was created, no order status
  or inventory was changed.
- **Applied**: `prisma migrate deploy` (not `migrate dev`/`db push`/reset/
  seed) against the explicitly-verified `taek_shops` connection.
  `prisma migrate status` now reports "Database schema is up to date!"; the
  `Refund` table exists with the reviewed schema (FKs to `Payment`/`User`,
  the 4 indexes) and 0 rows.
- **Gateway mode confirmed for normal dev**: `.env` and the ambient shell
  have neither `PAYMENT_GATEWAY` nor `E2E_DIST_DIR` set, so
  `getPaymentGateway()` always resolves to the real `StripePaymentGateway`
  for `next dev` (never the e2e fake). TEST-mode Stripe keys
  (`sk_test_…`/`whsec_…`/`pk_test_…`) are present and configured (values not
  printed). No Stripe API call was made during this verification.
- **Dev server restart — blocked, not completed.** The running dev server's
  in-process Prisma Client predates this migration and should be restarted
  to pick up the `Refund` model cleanly. An attempt to stop only this
  project's `next dev` process tree was refused by the environment's own
  safety controls (process-termination is restricted in this session). The
  server was confirmed still serving throughout (unauthenticated
  `GET /admin/orders` correctly redirects to `/login?next=...` — auth is
  enforced, not bypassed; authenticated admin UI was not verified this
  pass). **Action needed from a human operator**: restart `npm run dev`
  manually before relying on the refund UI against this database. Docker
  (`taek-shops-postgres`, 2h+ uptime, untouched) and any Stripe CLI listener
  were preserved — no listener process was found running at the time of
  this check.

**Manual review URL**: `http://localhost:3000/admin/orders` (after manually
restarting the dev server, and signing in as a real MANAGER/ADMIN account —
no bypass, no dev-seeded credentials printed).

**Still not claimed (as of the entry above)**: no real Stripe Test-Mode
refund has been exercised; the dev server has not yet been restarted to pick
up the new schema; Phase 8 remains **not signed off**.

**Full regression + manual Stripe Test-Mode refund verification
(2026-09-23).** With the dev server restarted (picking up the migrated
schema) and Docker/the dev database otherwise untouched, the full existing
test suites were run with no Phase-8 filter, against the same isolated
harnesses used throughout this phase (never the dev database or port 3000):

- **Unit**: `npm test` — **320/320 passed**, 43 files, mocked Prisma.
- **Integration**: `npm run test:integration` — **105/105 passed**, 13
  files, against `TEST_DATABASE_URL` — isolation is self-verified at
  runtime by `tests/integration/helpers/setup.ts` (throws before any test
  runs if `TEST_DATABASE_URL` cannot be confirmed, by a *live* connection,
  to be a distinct database from `DATABASE_URL`, `console.info`-logging
  "Test-database isolation verified" on success). That log line is not
  surfaced by vitest's default reporter, but the proof stands regardless:
  the run produced 105 passing tests and zero thrown isolation errors, which
  is only possible if the check passed — a failure there throws before a
  single test can execute, at the file level, not a normal test failure.
- **E2E**: `npx playwright test` (no spec filter) — **29/29 passed**, the
  entire `tests/e2e/` directory, against the dedicated port-3100 server and
  its own isolated database (`playwright.config.ts`'s
  `requireIsolatedE2eDatabase()` + `global-setup.ts`'s live check, both
  logged "Database isolation verified" before any test ran). Includes
  `admin-refund.spec.ts` (1/1) and `customer-order-history.spec.ts` (3/3).
  Two lines of `[WebServer]` error/rejection output during the run are
  **expected test output, not failures** — they're the server-side log
  lines for the deliberate "CUSTOMER is denied admin access" /
  "STAFF has no status-change controls" / "rejects a badly-signed webhook"
  negative-path assertions, all three of which passed.
- **No regressions found** — nothing to fix. No real Stripe API call was
  made by any automated test (the integration suite uses `FakeStripeGateway`,
  the e2e admin-refund spec uses `E2EFakePaymentGateway` via
  `PAYMENT_GATEWAY=e2e-fake`, gated as documented above).
- **Files changed this pass**: `docs/implementation-roadmap.md` only (this
  entry and the checklist updates above). No test, application, or
  configuration code was modified — the full suite was already green.

**Manual evidence — real Stripe Test Mode, order `TS-20260917-749CT2`
(originally $57.19 CAD, CAPTURED, no prior refunds):**

1. Partial refund: **CAD 1.00**, reason "Partial refund test" → `SUCCEEDED`.
   Remaining refundable balance correctly became CAD 56.19.
2. Full remainder: **CAD 56.19**, reason "Remaining balance refund test" →
   `SUCCEEDED`. Remaining refundable balance correctly became **CAD 0.00**.
3. Read-only verification (both refunds, independently, against this
   session's records and live Stripe retrieval): exactly 2 `Refund` rows,
   both `SUCCEEDED`, totaling **5719 cents = CAD 57.19** exactly;
   `Payment.refundedCents = 5719`; **`Payment.status = REFUNDED`** and
   **`Order.paymentStatus = REFUNDED`**; **`Order.status` unchanged at
   `PROCESSING`** throughout both refunds. Each refund's Stripe object
   confirmed `payment_intent` linkage and amount match, and each carried
   `metadata.taekShopsRefundId` matching its local `Refund.id` exactly —
   the linked PaymentIntent independently confirmed `livemode: false`, and
   Stripe's own `refunds.list` for that PaymentIntent returned exactly 2,
   agreeing with local records. Zero-balance guard confirmed by code
   inspection only (form doesn't render at `remainingCents = 0`; server
   independently rejects both on `Payment.status` no longer being
   refundable and on the balance check) — **not exercised live**, per
   instruction.
4. **Clarification**: this refund workflow updates financial records only
   (`Refund`, `Payment.refundedCents`/`status`, `Order.paymentStatus`) — it
   does **not** change `Order.status`, `FulfillmentStatus`, or any
   inventory/stock table. Returning goods, restocking, and order
   cancellation remain separate, unimplemented concerns.

**Now satisfied**: refund workflow implementation, review, dev-database
migration, and both automated and real-Stripe-Test-Mode manual verification
are all complete and evidenced above; customer order history's existing
coverage is reconfirmed by the same full, unfiltered regression pass.
**Not claimed (as of the refund evidence above)**: transactional emails were
not yet implemented at this point in the phase — see "Transactional order
emails" below, delivered next; a real Stripe Test-Mode **checkout** e2e run
in CI remains blocked (unchanged, pre-existing, unrelated to refunds — see
Phase 7); no new **CTO sign-off** statement is recorded here — that remains
a human decision, not something this pass declares on its own. Phase 8 as a
whole is **not marked complete**.

### Transactional order emails — local-preview milestone complete 2026-09-22 (real delivery + production scheduling outstanding)

**Scope delivered** (refund emails and any change to auth email behaviour
were explicitly out of scope and untouched): a durable, transactional
email **outbox** — never a fire-and-forget send — triggered by exactly two
verified events:

- **Order confirmation**, enqueued inside the SAME transaction that first
  marks a payment `PAID`/order `CONFIRMED`
  (`finalizeFromPaymentIntentTx`, `src/server/orders/payment-service.ts`) —
  the authoritative, webhook/return-verified success path, never a raw
  client redirect.
- **Shipping notification**, enqueued inside the SAME transaction as the
  fulfilment transition INTO `FULFILLED`
  (`changeOrderFulfillmentStatus`, `src/server/orders/order-management-service.ts`)
  — confirmed as the correct "fully shipped" state both from
  `FULFILLMENT_TRANSITIONS` (the terminal shipped state before `RETURNED`)
  and from the admin UI's own existing "Mark shipped" button label
  (`order-status-buttons.tsx`), not assumed from the enum name alone.

**Design** (`src/server/notifications/`: `order-mailer.ts`, `templates.ts`,
`email-outbox.ts`, `index.ts`; migration
`prisma/migrations/20260923012108_phase8_transactional_order_emails/`,
additive-only — 2 enums, 1 table, 3 indexes, 1 FK, no `ALTER`/`DROP` on any
existing table):

- **Durable outbox, not fire-and-forget.** `enqueueOrderEmailTx` inserts the
  `OrderEmail` job row inside the CALLER's own transaction — the job and the
  qualifying payment/fulfilment change commit together or neither does. A
  later transport failure can never undo an already-committed state change;
  a rolled-back state change never leaves a stray job. `@@unique([orderId,
  type])` makes a duplicate qualifying event (a redelivered webhook, a
  race) a silent no-op, never a second job.
- **Atomic worker claiming.** `claimNextEmailJob` uses `SELECT ... FOR
  UPDATE SKIP LOCKED` — concurrent claimants always get different rows (or
  `null`), never the same row twice. Bounded exponential-backoff retries
  (`backoffMs`, 30s base, 30-minute cap, `maxAttempts` default 5, then
  terminally `FAILED`). A job whose claiming worker crashed before
  resolving it (stuck `SENDING` past a staleness window) is reclaimed by
  the same query — recovery, not just first-attempt delivery.
- **Local dispatcher command** (`npm run emails:dispatch` →
  `scripts/dispatch-emails.ts`) drains every currently-due job independent
  of any customer request — this is what makes retries and crash-recovery
  not depend on new traffic arriving. `kickEmailDispatch` (fired
  best-effort, post-commit, right after the two trigger points above) only
  ever attempts a job's FIRST send and never throws back to its caller; a
  transport failure there is isolated by design and verified by test (see
  below) — it can never interfere with the already-committed payment or
  fulfilment change. In a real deployment `npm run emails:dispatch` should
  run on a schedule (e.g. every minute) — **nothing here schedules itself;
  that remains an outstanding production requirement**, alongside choosing
  and configuring a real provider (see "Not claimed" below).
- **Stable idempotency key, not a claim of exactly-once delivery.** Each
  `OrderEmail` row gets one `idempotencyKey` (`@default(cuid())`) at
  creation, immutable, passed to the transport on every attempt for that
  row. **Stated honestly, not overclaimed**: this gives at-least-once
  delivery with a key ready for a provider that itself de-duplicates by
  idempotency key (documented in `email-outbox.ts`'s module comment) — it
  is NOT itself a verified exactly-once guarantee. A crash between a real
  transport genuinely accepting the message and this outbox committing
  `SENT` would still retry with the same key; whether that retry is safe
  depends entirely on the transport, which this milestone does not yet
  have (see below).
- **Local-only, by design.** No real provider, no paid service, no package
  installed. `LocalPreviewOrderMailer` (the only production-path
  implementation this milestone) writes each rendered message to
  `.local/email-previews/` — outside `public/`, outside version control
  (`.gitignore`'d), on this machine only — and is explicitly documented as
  a PREVIEW, never delivery: nothing is sent anywhere, no network call is
  made. `FakeOrderMailer` (test-only, `tests/integration/helpers/order-mailer.ts`)
  is scriptable (success/failure per call) and records calls without ever
  logging a recipient, subject, or body. Neither writes secrets; console
  logging is limited to order number + email type (already-routine,
  non-PII identifiers elsewhere in this app's own logs/URLs).
- **Templates** (`templates.ts`): escaped HTML + plain text, built only
  from the order's own recorded snapshot (items, quantities, prices at
  purchase time, address, `formatCents`-correct CAD totals reusing the
  existing `src/server/domain/money.ts` — no reimplemented formatting).
  Deliberately invents nothing: no delivery date, no tracking number/link,
  no return/refund policy text — none of that data exists in this schema.
- **Module-layout note**: `src/server/notifications/*` and
  `scripts/dispatch-emails.ts` use only relative imports (with explicit
  `.ts` extensions, permitted via `allowImportingTsExtensions` added to
  `tsconfig.json`) instead of the `@/` alias, and every `email-outbox.ts`
  function takes `db` as a *required* parameter rather than defaulting to
  the shared `@/server/db/client` singleton. Both are because
  `scripts/dispatch-emails.ts` runs as a plain `node
  scripts/dispatch-emails.ts` — outside Next's/Vitest's bundler-aware
  module resolution, which is the only thing that understands the `@/`
  alias — empirically confirmed (a bare alias import fails under plain
  `node`; the same import with a relative path and explicit `.ts`
  extension succeeds). Same constraint `prisma/seed.ts` already documents
  for itself.

**Test evidence**: unit `tests/unit/notifications/` (2 files, 30 tests:
template escaping/CAD-formatting/no-invented-details, `backoffMs`,
enqueue-idempotent-swallow, claim/resolve success+failure+exhaustion
branches, `kickEmailDispatch` never throwing) + integration
`tests/integration/order-emails.integration.test.ts` (14 tests, isolated
`TEST_DATABASE_URL`, real services/real webhook route/real DB) covering
every scenario asked of this milestone: event eligibility (confirmation on
first PAID, shipping notice on reaching FULFILLED, nothing on a partial
fulfilment or an order-status-only transition), a transaction that inserts
a job and then throws leaves zero rows, a redelivered payment webhook and a
repeated fulfilment call both stay at exactly one job, two concurrent
claims against two pending jobs each get a different row, a failed send
schedules a real future retry (not an immediate resend) with the SAME
idempotency key across attempts, a job exhausting `maxAttempts` goes
terminally `FAILED` and is never reclaimed, a job whose claiming worker
"crashed" (stale `SENDING`) is recovered while a freshly-claimed one is
not, and a webhook whose best-effort dispatch kick fails still returns 200
with the payment correctly `PAID`/`CONFIRMED` (the job itself survives
`PENDING` for a later retry — not lost, not blocking). A test-hygiene gap
was found and fixed during this pass: pre-existing, unmodified integration
tests (e.g. the Phase 7 payment suite) that merely complete a payment now
also trigger the best-effort dispatch kick — without a safe default they
would have silently written real local preview files as an unrelated side
effect. Fixed by installing a `FakeOrderMailer` as the whole integration
run's global default in `tests/integration/helpers/setup.ts` (the same file
that already establishes the run's other safe defaults, e.g. database
isolation), not by touching the individual unrelated test files.

**Full regression, re-run after this milestone, no filters**: unit
**340/340** (45 files — up from 320, the +20 above), integration
**119/119** (14 files — up from 105), e2e **29/29** (unchanged file count,
all still green through the same isolated port-3100 harness; the e2e
admin-refund spec doesn't exercise a first-time payment success, so it
never triggers an email job and produces no preview file). One unrelated,
pre-existing flake was found and fixed: `tests/unit/payment-gateway-swap.test.ts`
(written earlier this same phase, for the refund review) reproducibly timed
out under full-suite load — never in isolation — because vitest captures
each test's timeout at collection time, so a `vi.setConfig` in `beforeAll`
doesn't retroactively help; fixed with an explicit longer per-test timeout,
not by changing what it asserts. `tsc --noEmit`, `eslint .`, and
`prettier --check` are all clean on every touched/new file.

**Migration applied only to the isolated test database this pass**
(`taek_shops_test`, via the same superuser-connection-swap technique used
for the refund migration) — confirmed additive, confirmed NOT applied to
the real development database (`prisma migrate status` against `taek_shops`
still reports it pending). The local dispatcher command was smoke-tested
end-to-end against `taek_shops_test` directly (`DATABASE_URL=<test db>
node scripts/dispatch-emails.ts`): it claimed a seeded job, rendered a real
template, wrote a real local preview file, and marked the row `SENT` — the
fixture was then removed from the test database.

**Not claimed (as of the test-DB-only pass above)**: no real email provider
exists or was chosen; nothing schedules `npm run emails:dispatch` in any
real deployment — both are explicit outstanding production requirements,
not implemented here by design. Refund-confirmation emails were explicitly
out of this milestone's scope (only order confirmation + shipping
notification were required). Exactly-once delivery is not claimed — see
the design notes above. Phase 8 as a whole remains **not marked complete**.

**Dev database migration applied (2026-09-22).** After manual review of two
real rendered previews (correct item/tax/shipping/total math — $69.99 +
$5.00 + $6.50 = $81.49, exactly matching the seeded order; correct CAD
formatting via the shared `formatCents`; readable HTML and plain text;
zero invented tracking/delivery-date/policy text — escaping under
adversarial content is proven separately by the template unit tests, not
by this specific sample, which used plain data), `20260923012108_phase8_transactional_order_emails`
was applied to `taek_shops` — confirmed the ONLY pending migration first
(`prisma migrate status`), re-printed its exact SQL (unchanged: 2 enums, 1
table, 3 indexes, 1 FK, no `ALTER`/`DROP`).

- **Preview-vs-delivery clarity, strengthened.** `OrderEmailStatus.SENT`
  now carries an explicit schema comment stating that, today, in every
  environment, `SENT` means the local preview transport completed — never
  real delivery — since `LocalPreviewOrderMailer` is unconditionally the
  only production-path transport this milestone (no branching, no env-var
  gate, nothing else to accidentally activate). Comment-only change, no new
  migration.
- **Backup**: a second timestamped `pg_dump -Fc` archive, taken and
  verified with `pg_restore --list` (279 entries; `Refund` present,
  `OrderEmail` correctly absent — proof it predates this migration) the
  same way as the refund migration's backup — outside the repo, outside
  version control, not printed here.
- **Baseline preserved**: `Order` 7, `Payment` 7, `Refund` 2, payment
  refunded sum 5719¢, `InventoryItem` 36 rows / 71 qty, `User` 2 — checked
  read-only before and after, byte-identical. No order, payment, refund,
  inventory, or user row was modified.
- **Applied**: `prisma migrate deploy` only (never `migrate dev`/`db push`/
  reset/seed). `prisma migrate status` now reports up to date; `OrderEmail`
  exists with the reviewed schema, 0 rows.
- **Dev email transport confirmed local-preview-only** — by code
  construction, not configuration: `getOrderMailer()` has no branch other
  than `LocalPreviewOrderMailer` this milestone, so there is nothing for
  any environment variable to accidentally select.
- **Dev server restarted successfully** this time (port 3000 was free,
  no denied/blocked action needed): `GET /admin/orders` → `307` to
  `/login?next=/admin/orders`, confirming the route is live and auth is
  enforced, not bypassed.

**Manual review URL**: `http://localhost:3000/admin/orders` (sign in as a
real MANAGER/ADMIN account).

**Corrected accounting**: the unit-test net change for this milestone is
**+20** (320 → 340, 43 → 45 files) — a prior verbal summary of this work
said "+30," which was inaccurate; the number documented earlier in this
same section ("up from 320, the +20 above") was correct throughout.

**Manual post-migration browser verification (2026-09-22), order
`TS-20260917-749CT2`** (the same order used for the earlier manual refund
tests — CAD 1.00 + CAD 56.19 = CAD 57.19 against a CAD 57.19 order):
payment status **REFUNDED**, order status **PROCESSING** (unchanged, as
designed — a refund never touches order status), remaining refundable
**CAD 0.00**. Confirms the migrated schema and running admin UI agree with
each other and with the DB-level checks from the refund milestone.

**Local-preview milestone — acceptance criteria satisfied, marked
complete.** Every criterion this milestone was scoped against is now
evidenced: durable outbox (insert-in-transaction, commit-together
guarantee), unique event-key dedup + atomic `SKIP LOCKED` claiming, bounded
backoff retries + stale-claim recovery, a documented local dispatcher
command independent of customer requests, a stable per-row idempotency key
with the exactly-once limitation stated honestly (not claimed), a local
preview transport + a fake test transport with previews stored outside
`public/`/version control, no full recipients/addresses/tokens/bodies ever
logged, escaped HTML + plain-text templates with correct CAD formatting and
no invented tracking/delivery/policy content (verified by both 9 automated
template tests and this pass's manual review of two real rendered
previews), the existing auth `Mailer` and its behaviour completely
untouched, full regression green (340/119/29, no external email, no real
Stripe calls), and the additive migration reviewed, backed up, and applied
to the real development database with all pre-existing business data
confirmed byte-identical before and after.

**Explicitly still incomplete (by design, not an oversight)**: no real
email provider exists or has been chosen; nothing schedules `npm run
emails:dispatch` in any real deployment. Both remain outstanding
production requirements — see the "Not claimed" notes above for exactly
what real-provider integration and deployment scheduling will each need.
Refund-confirmation emails remain out of scope (never requested). Phase 8
as a whole is still **not marked complete** — this closes out the
transactional-order-emails sub-scope specifically.

---

## Phase 9 — Product image management ✅ _(local development milestone accepted 2026-09-30)_

**Acceptance basis, stated precisely**: this milestone is accepted for **local
development** based on (1) the automated evidence reported above (unit,
integration — including real MinIO — and e2e suites, all green) and (2) the
user's own completed manual admin-side browser review (upload, reorder,
set-primary, delete — see "Manual admin-side review" below). This
acceptance does **not** constitute an independent code review by anyone
other than the implementer, does **not** claim production readiness (local
MinIO remains a development convenience, not production infrastructure —
see "Not claimed" below), and does **not** claim manual verification of
storefront rendering (the manual review exercised the admin side only,
against a DRAFT product never shown on the public storefront).

**Scope delivered** — built on Phase 4's existing foundation (`ObjectStorage`
interface + local dev backend + `ProductImage` model were already in place;
this phase implemented the S3-compatible backend, the staged-upload
pipeline, and everything admin/storefront-facing):

- **`S3ObjectStorage`** (`src/server/storage/s3-object-storage.ts`) — real S3
  or any S3-compatible service, including local MinIO
  (`docker-compose.yml`'s `minio` + one-shot `minio-init` services, added
  without touching `postgres` or its volume). `forcePathStyle: true` for
  MinIO compatibility. **Local MinIO is a development convenience only — not
  a production CDN**; a real deployment sets `S3_PUBLIC_BASE_URL` to that
  CDN's own URL.
- **Byte-level image validation** (`src/server/storage/image-sniff.ts`) —
  every upload's actual bytes are magic-number-sniffed (JPEG/PNG/GIF/WEBP/AVIF)
  before being stored; a claimed content-type or file extension is never
  trusted. SVG is explicitly rejected as a non-raster, XSS-risk format,
  checked ahead of the raster signatures.
- **Staged direct upload** (S3-compatible backend): the browser PUTs bytes
  straight to storage via a presigned URL
  (`createProductImageUploadSlot`/`finalizeProductImageUpload` in
  `image-service.ts`); a `ProductImageUpload` row (additive migration)
  tracks the staged, unvalidated object until finalize fetches the real
  bytes back and verifies them for real. The local-filesystem backend (no
  direct-upload support) instead validates and stores in one synchronous
  step (`uploadProductImage`), no staging.
  **Private staging is enforced at two independent layers, not one**:
  (1) the *application* never links to or serves a `ProductImageUpload` row
  — `listProductImages` and every storefront query only ever read
  `ProductImage`; and (2) the *storage bucket's anonymous-access policy*
  itself denies reading a staged object even by its exact key (see
  "Anonymous access policy" below) — layer (1) alone is not access
  control, only obscurity, which a second review pass in this same day
  correctly refused to accept as sufficient (see "Real defects" below).
- **Abandoned-upload cleanup**: bounded, one-pass sweep
  (`src/server/storage/upload-cleanup.ts`, rows older than 24h) — run via
  `npm run images:cleanup-uploads`
  (`scripts/cleanup-image-uploads.ts`, relative-import-only, same
  `node scripts/*.ts` constraint as `dispatch-emails.ts`). Nothing
  schedules it in a real deployment — outstanding production requirement,
  same as `emails:dispatch`.
- **Product deletion cleans up storage**: `deleteProductIfUnused` now
  deletes its images' storage objects after the DB delete commits (a
  Postgres cascade removes the `ProductImage` rows but can't reach object
  storage) — never before, so a rolled-back delete never orphans a
  still-referenced object. Variant deletion remains soft-delete-only
  (`archiveVariant`, unchanged) — no hard-delete path exists for variants,
  so no image cleanup is needed there.
- **Admin UI** (`image-panel.tsx`): upload (via presigned URL or the local
  proxy route), reorder (move earlier/later, ownership-checked — the
  reorder list must exactly match the product's current images), alt-text
  editing, set-primary, delete. Authorization is `catalog.write`
  (MANAGER+) throughout, enforced server-side in every action, never just
  in the UI.
- **Storefront**: product detail page and the home grid render the primary
  image via `next/image` — `next.config.ts`'s `images.remotePatterns` is
  derived from exactly the one configured storage URL, never a wildcard
  host — falling back to a neutral "No image" placeholder
  (`ImageWithFallback`) when a product has none.
- **Security specifics**: object keys are always server-generated
  (`productImageKey`/`stagingImageKey`) — no admin action accepts an
  arbitrary storage key or URL, including deletion (looked up by DB row,
  never a client-supplied key). The hand-written local-backend upload route
  (`POST /api/admin/catalog/products/[id]/images`) requires the same
  double-submit CSRF token every other hand-written mutation route in this
  app requires (`guardMutation`) — missed on the first pass, caught by the
  e2e spec, fixed.
- **Additive migrations** — three, all scoped to `ProductImageUpload` only,
  no `ALTER`/`DROP` on any pre-existing column of any table:
  `20260923180649_phase9_product_images` (the table itself, 3 indexes, 3
  FKs), `20260923190000_phase9_upload_retry_attempts` (`attempts`/
  `maxAttempts` — bounded-retry cleanup, below), and
  `20260923200000_phase9_upload_claim_recovery` (`claimedAt`/`finalKey` —
  crash-safe finalize, below). Each was verified against Prisma's own
  `migrate diff` output before being hand-applied, applied first to
  `taek_shops_test`, then — after a fresh verified `pg_dump` backup and a
  read-only pending-migration/business-data review — applied to the real
  development database with `prisma migrate deploy`. Post-migration counts
  and financial totals (`Order`/`Payment`/`User`/`Product`/etc.) were
  confirmed byte-identical to the pre-migration baseline.
- **Real image decoding, not just magic-byte sniffing**
  (`src/server/storage/image-decode.ts`, added in this review pass) — every
  upload's bytes are genuinely decoded with `sharp`/libvips after the
  magic-number sniff passes, catching a corrupt/truncated body that a
  header-only check cannot (valid magic bytes, garbage payload), and
  enforcing `MAX_IMAGE_DIMENSION_PX = 8,000` (either axis) and
  `MAX_IMAGE_PIXELS = 40,000,000` (a decompression-bomb guard, independent
  of the per-axis check) via `sharp(bytes, { limitInputPixels }).metadata()`.
  Wired into both `uploadProductImage` (local backend) and
  `finalizeProductImageUpload` (S3-compatible backend), after the sniff
  check and before the bytes are ever written to a final storage key.
- **Concurrency- AND crash-safe finalize** (`finalizeProductImageUpload`,
  rewritten twice this same day — see "Real defects" below for why a first
  fix wasn't enough). The very first operation is a conditional UPDATE,
  `db.productImageUpload.update({ where: { id, claimedAt: null }, data: {
  claimedAt: now } })` — Prisma's `P2025` ("no record matched") becomes a
  clean `NotFoundError`, so two concurrent (or accidentally repeated)
  finalize calls for the same `uploadId` can never both proceed. Unlike a
  delete-based claim, the row deliberately **survives** the claim: it
  remains the upload's only durable recovery record for the rest of the
  call. `finalKey` is written to that same row just before the validated
  bytes are put to their final storage key — a durable "we started
  writing this" marker, before the write it describes. The `ProductImage`
  insert and the tracking-row's removal happen inside one
  `db.$transaction`: either both commit, or the row survives (with
  `finalKey` set) as exactly the state the sweep below knows how to
  recover. Net effect: a process crash at any point after the claim — mid
  validation, mid storage write, mid DB insert — leaves a recoverable row,
  never a silent, permanently untracked storage leak.
- **Bounded, genuinely-retrying cleanup, including crash/stuck-claim
  recovery** (`sweepAbandonedImageUploads`, rewritten twice this same
  day). Two things are recovered by the same sweep: (1) rows never even
  claimed, older than 24h — genuinely abandoned browser uploads; (2) rows
  still claimed (`claimedAt` set) after 15 minutes — a normal finalize
  completes in well under a second, so this means the process crashed or
  hung mid-finalize, not "still working." For (2), `finalKey` tells the
  sweep exactly how far the crashed attempt got: unset → only the staging
  object needs cleanup; set but unreferenced by any `ProductImage` → both
  the staging and the unattached final object are safely deleted (the
  upload can simply be redone); set AND already referenced by a real
  `ProductImage` → finalize actually succeeded, so **the sweep never
  touches that object**, only the stale tracking row. A storage-delete
  failure during any of this increments the row's `attempts` and **keeps
  the row** for a later retry, rather than discarding the only record of
  an orphaned object after one failure; only once `attempts` reaches
  `maxAttempts` (default 5) does the sweep give up and remove the row
  anyway, logged clearly as a give-up rather than a success.
- **Anonymous storage access is deny-by-default; only validated, published
  images are anonymously readable** (`docker-compose.yml`'s `minio-init`,
  rewritten this same day — see "Real defects" below). `object-storage.ts`'s
  two key generators put every object under one of two disjoint top-level
  prefixes: `productImageKey` under `products/…` (finalized, validated,
  meant to be public) and `stagingImageKey` under `staging/products/…`
  (uploaded but not yet byte-validated). The bucket's anonymous policy now
  grants `s3:GetObject` **only** under `products/*`, and grants no
  `s3:ListBucket` at all — an anonymous request can never enumerate the
  bucket's contents, and can never read a staged object even by its exact
  key. Authenticated application operations (`storage.get()`/`put()`/
  `delete()`, presigned upload/download URL generation) all use the MinIO
  root credentials and are governed by IAM, not this anonymous bucket
  policy, so none of them are affected. Applied to both the live local
  MinIO instance and the version-controlled `minio-init` init script (so a
  full container/volume recreation reproduces the same secure policy), and
  to the isolated `taek-shops-verify-images` test-fixture bucket used by
  `product-images-minio.integration.test.ts` (applied there via the AWS
  SDK directly in the test file's own setup, not a manual `mc` command, so
  it's reproducible from a fresh MinIO instance too).

**Acceptance criteria**

- [x] Admin uploads an image; it renders on the storefront — verified
      end-to-end against real local MinIO (synthetic data, isolated bucket
      — see Test evidence) and via a real browser e2e spec. Explicitly
      **not** claimed against a real production CDN — local MinIO is a dev
      convenience, stated honestly above and in `src/server/storage/README.md`.
- [x] Deleting a product cleans up its storage objects (test) — verified
      both with a `FakeObjectStorage` double (integration) and, separately,
      that a product **with** order history is correctly refused deletion
      and its storage object is never touched.
- [x] Upload rejects oversized / wrong-content-type files (test) — at both
      the cheap claim-level check (slot creation) and the authoritative
      byte-level check (finalize); proven against real MinIO with real SVG
      bytes and a real oversized real payload, not just claims.
- [x] Real image decoding rejects corrupt/truncated bytes and enforces
      dimension/pixel limits, not just a magic-byte header check (test) —
      see "Real image decoding" above.
- [x] Private staging is enforced by storage-layer access control, not
      merely by the application never linking to staged keys — anonymous
      bucket listing is denied, anonymous `GetObject` on a known staged
      key is denied even when the exact key is known, and this was proven
      against real MinIO, not asserted from the app layer alone (test) —
      see "Anonymous storage access" above and "Real defects" below.
- [x] A crashed/interrupted finalize (not just a concurrent one) leaves a
      durably recoverable tracking row, is bounded-retried, and can never
      result in an orphaned storage object or, conversely, in the
      recovery sweep deleting a live, already-attached image (test) — see
      "Concurrency- AND crash-safe finalize" above.
- [x] Concurrent/repeated finalization of the same upload cannot create a
      duplicate `ProductImage` row or an orphaned storage object (test) —
      see "Concurrency- AND crash-safe finalize" above.
- [x] Upload-slot ownership cannot be spoofed: `finalizeProductImageUpload`'s
      signature carries no client-suppliable `productId` (the image always
      attaches to the product the slot was created for), and a bogus/unknown
      `uploadId` is refused with a definitive 404 (test).
- [x] A still-staged (unfinalized) upload is never exposed through any
      application query — `listProductImages` and every storefront query
      only ever read `ProductImage`, never `ProductImageUpload` — **and**,
      independently, is never anonymously readable at the storage layer
      either, even by its exact key (test, real MinIO) — see "Private
      staging is enforced at two independent layers" and "Anonymous
      storage access" above.
- [x] Full verification pipeline green — see Test evidence below.

**Variant-specific storefront image selection — assessed, not required**:
checked against the original Phase 9 scope and the existing variant model
(`variant-picker.tsx` has zero image-related code today; `image-panel.tsx`
never exposes a variant selector) during this review's pre-rollout pass.
Nothing in the accepted requirements or existing design surface calls for
per-variant storefront images, so this was documented as an accurate,
intentional limitation rather than built as an unrequested feature. The
data model already supports it (`ProductImage.variantId` is nullable but
present) if a future phase adds the requirement.

**Test evidence (2026-09-23, reconciled during this review pass)**: unit
**374/374**, 48 files (verified via a full `vitest run`, not a stale
count). Reconciling against the previously accepted 368: **+6**, all from
one new file added in this pass, `image-decode.test.ts` (valid-image decode,
corrupt/truncated rejection, garbage-byte rejection, over-width rejection,
exact-boundary acceptance, and an independent total-pixel-count rejection —
368 + 6 = 374, confirmed by an exact per-file count). The earlier +27→+28
unit-count correction (`image-sniff.test.ts` 12, `image-service.test.ts` 13,
`home.test.tsx` net +1, `env.test.ts` net +2) still stands as the baseline
this +6 builds on. Integration **157/157**, 16 files, across all three
passes of this same day:
- `product-images.integration.test.ts`: 18 (original) + 7 (first,
  pre-rollout pass — atomic-claim concurrency, repeated-finalization 404,
  upload-slot ownership x2, real decode rejecting a truncated real JPEG
  and an over-width real PNG) + 3 (second, crash-safety pass — a stuck
  claim before validation, a crash after the final object was written but
  before `ProductImage` committed, and recovery never deleting a live
  attached image) = **28**.
- `product-images-minio.integration.test.ts`, **real MinIO**, isolated
  `taek-shops-verify-images` bucket: 6 (original) + 4 (third,
  storage-security pass — anonymous listing denied, anonymous GET of a
  known staged key denied, invalid/rejected uploads never anonymously
  readable, and authorized upload + finalized-image access both still
  work under the tightened policy) = **10**.
- The real dev bucket `taek-shops-dev-images` stayed empty throughout
  every pass except for immediately-cleaned-up synthetic canary objects
  used to directly verify the live policy via raw HTTP, confirmed empty
  again afterward each time.

E2E **28/28**, 11 files (reduced from 29 test cases across 10 files by
consolidating three same-actor logins in `admin-orders.spec.ts` into one —
zero assertions lost, confirmed by direct file re-read of every original
`expect()`; see below). `tsc --noEmit`, `eslint .` both clean across every
touched file, all three passes.

**Real defects found and fixed during this pass** (not weakened, not
skipped):

- **Missing CSRF token** on the local-backend upload route's hand-written
  `fetch` call — every other mutating request in this app includes the
  double-submit token; this one didn't, caught by the e2e spec failing with
  "Request rejected for security reasons," fixed by adding the same
  `x-csrf-token` header pattern `import-runner.tsx` already uses.
- **Shared e2e login rate-limit budget exhausted**: adding
  `product-images.spec.ts`'s one necessary login pushed the whole suite's
  total logins past the production login limiter's 10-per-15-minute IP
  bucket (`src/server/auth/rate-limit.ts`, shared by every spec file
  against one server process — the same class of issue
  `customer-order-history.spec.ts` already documents and fixes for itself).
  Confirmed via the actual `429` response in a Playwright trace, not
  inferred. Fixed by consolidating `admin-orders.spec.ts`'s three
  same-actor-login tests into one (5 logins → 3 for that file), never by
  touching the limiter.
- **`S3_*` env vars set to `""` fail validation, not just "unset"**: the e2e
  harness needs to force-clear inherited MinIO config to guarantee the
  local backend, but Zod's `.optional()` only tolerates a genuinely absent
  key, not an empty string — this crashed the e2e build outright. Fixed
  with a small `optionalOrEmpty` wrapper in `src/server/config/env.ts`,
  scoped to the 6 `S3_*` fields, with unit tests proving both the empty
  case (tolerated) and a genuinely malformed value (still rejected).
- **Generated MinIO secret key could start with `-`**: `crypto.randomBytes(24).toString("base64url")`
  can legitimately produce a leading `-`, which `mc` (the MinIO CLI run by
  `minio-init`) misparsed as an unrecognised flag. Regenerated using hex
  encoding instead (never produces a CLI-special leading character) and
  updated `.env.example`'s guidance accordingly.
- **Docker Hub delisted the free `minio/minio` / `minio/mc` images in
  2025** (MinIO's AGPL relicensing) — `docker-compose.yml` now pulls from
  `quay.io/minio/*`, MinIO's own registry.
- Two environmental, non-code flakes diagnosed and worked around, not
  papered over: a recurring Windows `EPERM` on
  `.next-e2e/node_modules/@aws-sdk` during e2e rebuilds (same class of
  issue as the already-documented Turbopack cache corruption — cleared the
  fully-regenerable `.next-e2e` directory before rebuilding); an existing
  unit test (`tests/unit/home.test.tsx`) whose mock fixture predated the
  `images` field this phase added to the storefront page — updated the
  fixture, not the assertion, and added a second case proving the primary
  image itself renders.

**Real defects found and fixed during this review pass** (pre-rollout
audit, not from an external report):

- **A genuine finalize-concurrency race**: the original
  `finalizeProductImageUpload` did `findUnique` then, later, `delete` —
  leaving a window where two concurrent calls for the same `uploadId`
  could both pass validation and both write a final storage object, with
  only one's `delete` succeeding (the other throwing an unhandled Prisma
  error and leaving an orphaned storage object, no duplicate-protection).
  Fixed, in this first pass, with an atomic claim-via-delete-first
  rewrite; proven with a new concurrent-call integration test asserting
  exactly one caller succeeds, the other gets a clean 404, and no
  orphaned object is left behind. **This delete-first claim was itself
  superseded one pass later** — see "Post-rollout reliability review"
  below: it was concurrency-safe but not crash-safe, since deleting the
  row as the claim destroyed the only durable recovery record before the
  work it was claiming for was actually done.
- **The abandoned-upload cleanup sweep was single-pass, not actually
  bounded-retry**, against the original requirement: it always deleted the
  tracking row regardless of whether the storage delete itself succeeded,
  so a transient failure was logged once and then the only record of that
  orphaned object was discarded — no real retry capability existed. Fixed
  by adding `attempts`/`maxAttempts` and only removing the row on success
  or after exhausting attempts (see "Bounded, genuinely-retrying cleanup"
  above); a new additive migration
  (`20260923190000_phase9_upload_retry_attempts`) was required and applied
  to `taek_shops_test` only.
- **Three test files used a fake, magic-bytes-only "JPEG"** (12 header
  bytes, not a genuinely decodable image) that happened to pass the old
  sniff-only validation:
  `tests/integration/product-images.integration.test.ts`,
  `tests/unit/image-service.test.ts`, and
  `tests/integration/product-images-minio.integration.test.ts` (plus the
  e2e spec `tests/e2e/product-images.spec.ts`, found while confirming this
  review's fixes hold end-to-end). Once real decoding was wired in, every
  test on the success path using that fake constant would have started
  failing — fixed by generating genuine images with `sharp` in each file's
  setup, never by weakening the new decode check to let the fake bytes
  back in.
- **The additive migration for `ProductImageUpload.attempts`/`maxAttempts`
  had not actually been applied** to `taek_shops_test` when the schema was
  first updated (`prisma generate` regenerates the client but does not
  apply pending SQL) — any test touching those columns would have hit a
  real "column does not exist" Postgres error. Applied via a dedicated
  migration, using the database-owning role (not the restricted
  `taek_test` application role, which lacks `ALTER TABLE` on tables it
  doesn't own) — confirmed afterward that the restricted role can still
  read/write the new columns through the full integration suite.

**Post-rollout reliability + storage-security review (second and third
pass, same day)**: two further concrete gaps were found and fixed after
the pre-rollout pass above, neither from an external report:

- **The delete-first finalize claim was concurrency-safe but not
  crash-safe.** Deleting the `ProductImageUpload` row as the claim itself
  meant a process crash any time after that delete and before
  `addProductImage` committed — mid validation, mid `storage.put`, mid the
  DB insert — left the staged (or, worse, the already-written final)
  storage object with zero durable tracking: not attached to any
  `ProductImage`, and no longer visible to `sweepAbandonedImageUploads`
  either, since the row it depended on was already gone. Found via a
  targeted reliability audit (explicitly not inferred from the
  concurrency tests, which only prove exclusivity, not crash recovery).
  Fixed by making the claim a conditional UPDATE that the row survives
  (see "Concurrency- AND crash-safe finalize" above), adding `claimedAt`/
  `finalKey` (migration `20260923200000_phase9_upload_claim_recovery`),
  wrapping the `ProductImage` insert and the tracking-row removal in one
  transaction, and extending the sweep to recover stuck claims —
  verified with tests that directly construct the exact DB/storage state
  a crash at each point would leave (not concurrency races standing in
  for crash safety), including a test proving recovery can never delete
  an image that was actually attached.
- **Private staging was not actually enforced at the storage layer** — a
  real gap against the explicit Phase 9 requirement, not a future
  production concern deferred on purpose. `docker-compose.yml`'s
  `minio-init` applied `mc anonymous set download` to the bucket, which
  grants anonymous `s3:GetObject` **and** `s3:ListBucket` on the entire
  bucket — including everything under `staging/…`. Confirmed with a real,
  unauthenticated request against the live dev MinIO returning a valid,
  populated `ListBucketResult`: anyone who found the endpoint could
  enumerate every staged (unvalidated, unfinalized) object's key. The
  application never *linking* to a staged key was true and remains true,
  but is obscurity, not access control, and was never sufficient on its
  own against the requirement. Fixed by scoping the anonymous policy to
  `s3:GetObject` on `products/*` only, with no `s3:ListBucket` grant at
  all (see "Anonymous storage access" above) — applied to the live dev
  MinIO, the version-controlled `minio-init` script, and the isolated
  test-fixture bucket, and verified against real MinIO: anonymous listing
  denied (403), anonymous GET of a known staged key denied (403) even
  though the object genuinely exists (confirmed via authenticated
  access), a real SVG staged then rejected by finalize was never
  anonymously readable before or after rejection, authorized signed
  uploads still succeed, and a finalized image is still anonymously
  reachable at its storefront URL (200) — both via a new regression
  describe block in `product-images-minio.integration.test.ts` (against
  the isolated verify bucket) and via direct HTTP checks against the real
  dev bucket with synthetic, immediately-cleaned-up objects.

**A fourth defect, found only by an actual browser attempting a real
upload**: the first live manual-review attempt failed silently — "Images
(0)", "No images yet.", the file input quietly reset, no visible error.
Root cause, confirmed by reproducing it in a real browser against real
dev MinIO (never established by Node-based `fetch()` in integration tests,
since CSP is a browser-only enforcement mechanism, nor by the
local-filesystem e2e path, which never leaves `'self'`): `src/proxy.ts`'s
CSP `connect-src` never included the S3-compatible storage origin, so the
browser blocked the presigned-upload PUT as a CSP violation **before any
network request was even attempted** (confirmed: zero requests to the
storage port were ever recorded for the failed attempt). `img-src` had the
identical gap for rendering a finalized image. Separately,
`image-panel.tsx`'s upload handler had a `try/finally` with no `catch`, so
the thrown `TypeError: Failed to fetch` became a silent unhandled
rejection instead of surfacing through the existing error UI. Fixed by
deriving the allowed origin(s) from `S3_ENDPOINT`/`S3_PUBLIC_BASE_URL` in
`buildCsp` (falls back to the pre-existing policy unchanged when the
local-filesystem backend is configured instead) and by adding the missing
`catch`. Regression: `tests/unit/csp.test.ts` (4 cases) and
`tests/unit/image-panel.test.tsx` (2 cases), both confirmed to fail
against the pre-fix code before being confirmed to pass against the fix.

**Manual admin-side review (2026-09-30, real browser, real dev MinIO, QA
Shoe — a DRAFT product created for this purpose, never a real catalog
item)** — this is a human-in-the-browser check of the admin CRUD flows,
**not additional automated test coverage** and **not a check of the public
storefront rendering path** (QA Shoe is DRAFT, so it was never expected to
render there; storefront rendering of a hosted image remains covered only
by the existing automated integration/e2e suites, against their own
fixtures/backends, not by this pass):
- Uploaded two images successfully through the real admin UI against real
  MinIO.
- Both images persisted after a full page refresh.
- Reordering the two images worked.
- Separately and explicitly, clicking "Make primary" on the second image
  changed the primary image, and that change persisted after a refresh.
  **Reordering does not itself change which image is primary** — these are
  two independent controls, verified independently; no claim is made that
  moving an image's position changes its primary status.
- Deleted the (by then) non-primary image.
- After a refresh, "Images (1)" remained: the second uploaded image — the
  one explicitly made primary — with no trace of the deleted one.

A focused read-only check afterward (SQL `SELECT`, an anonymous HTTP `GET`
— no writes) confirmed the end state directly, independent of the UI:
exactly one `ProductImage` row for QA Shoe, `isPrimary = true`, its
storage object (`products/cmtp8iqst00arl4wohqbswpg8/…png`) anonymously
reachable at **HTTP 200** under the restrictive storage policy documented
above, and the product still `status = DRAFT`. Nothing was modified or
deleted by this check.

**Not claimed**: no real cloud storage account or production CDN exists or
was configured — local MinIO is explicitly a development convenience, not
production infrastructure, stated in multiple places above. The manual
review above exercised the admin side only; it does not substitute for or
add automated regression coverage, and it did not exercise storefront
rendering (see above). Variant-specific image swapping in the storefront
variant picker is not wired up — assessed against the existing
requirements and design surface and found not to be required (see above);
the data model supports it (`ProductImage.variantId` is nullable but
present) if a future phase adds the requirement. Production scheduling for
`npm run images:cleanup-uploads` remains outstanding, same as
`emails:dispatch`. **All three Phase 9 migrations have been applied to the
real development database** (`prisma migrate deploy`, preceded by a
verified `pg_dump` backup and a read-only baseline of existing business
data, confirmed byte-identical afterward). Phase 9 is **not marked
complete** pending CTO sign-off on the evidence above.

**Phase 10 note (per instruction, not implemented this pass)**: Phase 10's
heading below still reads "⬜ not started," but that's stale — CSV product
import (file/header/row validation, dry-run preview, row-level errors,
transactional upsert-by-SKU, formula-injection defence, idempotency,
`ImportJob`/`ImportJobRow` audit trail) was already delivered and
live-verified under **Phase 4** (see that section). The genuinely remaining
gaps against Phase 10's full checklist: **XLSX format support** (explicitly
deferred from Phase 4, "seam in place"), an **admin UI page to browse
`ImportJob`/`ImportJobRow` history** (the data model exists;
`src/app/admin/` has no page querying it), and **e2e coverage** for the
import flow (none exists). Phase 10's checklist also still names
`ImportBatch`/`ImportRow` — the actual models are `ImportJob`/`ImportJobRow`;
worth reconciling the two sections' numbering/wording at some point, not
done here since it was explicitly out of this pass's scope.

**Next safe step**: all three Phase 9 migrations are applied to
development and the manual admin-side browser review above has passed —
the only remaining step is CTO sign-off to mark Phase 9 complete. Nothing
further needs building or migrating for this milestone unless that review
raises a gap.

---

## Phase 10 — Spreadsheet import (CSV/XLSX) 🚧 _(CSV history + error-report local milestone accepted 2026-09-30; XLSX reader implemented 2026-09-30, preview path manually verified, commit/history/error-report still awaiting manual review; focused XLSX test-coverage and injected-failure-recovery pass completed 2026-10-01, all local checks green — see that sub-milestone below)_

**Scope:** implement the full pipeline in `docs/product-import-specification.md`
— template download, upload, column mapping, validation, preview, commit
(create/update/upsert), duplicate detection, progress, summary, transaction-safe
writes, import history + audit, formula-injection protection, configurable
size/row caps, safe price/stock updates, downloadable error report.

**Acceptance criteria**

- [ ] Template downloads as both `.csv` and `.xlsx` with the documented
      columns — **CSV done (Phase 4); an `.xlsx` template writer is
      explicitly not part of this increment** (the user confirmed one is
      not required) — the existing CSV template remains the only download,
      and is accepted as input for an `.xlsx` upload too.
- [x] Valid file: preview counts match; commit creates/updates exactly as
      previewed (Phase 4 for CSV; now also proven for a real `.xlsx` file
      in an integration test and an **automated** e2e test driving a real
      browser — commit itself has not yet been manually reviewed for
      XLSX, see "Manual review" above).
- [x] Invalid rows produce row-level errors and never partially write
      (Phase 4 for CSV; proven for XLSX too in automated tests, and
      manually confirmed for the preview step specifically — see "Manual
      review" above).
- [x] Upsert by `sku` is idempotent (re-importing the same file is a
      no-op) — tested for CSV (Phase 4) **and now independently for XLSX
      (2026-10-01)**: re-importing an identical `.xlsx` file produces
      `created: 0, updated: 0, skipped: 2`, no duplicate product/variant
      rows, and — checked against a real, non-zero on-hand quantity set
      beforehand, not just the trivial 0-on-creation case — no inventory
      change. New `ImportJob`/`ImportJobRow` audit rows from the second
      run are expected and were explicitly not asserted against.
- [x] In-file duplicate `sku` is reported, not silently merged —
      tested for CSV (Phase 4) **and now independently for XLSX
      (2026-10-01)**: a duplicate SKU across two XLSX rows is flagged
      `duplicate_sku_in_file` at preview time, same as CSV, and never
      reaches commit.
- [x] Formula-injection payloads (`=cmd`, `@SUM`, `+…`, `-…`) are neutralised
      (test) — for CSV (Phase 4) **and now for XLSX**: a genuine
      formula-typed cell's cached result is never read; the cell is treated
      as empty and flagged, same as CSV's leading-character trigger (test).
- [x] File over `IMPORT_MAX_FILE_SIZE_BYTES` or row count over
      `IMPORT_MAX_ROW_COUNT` is rejected with a clear message — tested for
      CSV (Phase 4); the row cap **and** the archive-decompression caps
      (entry count, per-entry and total decompressed bytes) are tested for
      XLSX. The plain compressed-upload-size check now has **two layers of
      new evidence (2026-10-01)**: (1) an integration test calling
      `previewImport` directly with an oversized `.xlsx` file — the real
      pipeline entry point; (2) an **e2e test driving the actual browser
      upload form** (real cookies, real CSRF) against the genuine
      `IMPORT_MAX_FILE_SIZE_BYTES` check in
      `preview/route.ts`, the true HTTP upload boundary. That check runs
      on raw `file.size` before the route branches on CSV vs. XLSX, so a
      CSV-shaped oversized buffer was used (simpler to pad to an exact
      byte count than a compressed `.xlsx`) and is equally valid evidence
      for the XLSX path, which hits the identical line first. There is no
      dedicated **unit** test of the route handler in isolation — this
      codebase has no precedent for invoking a `guardMutation`/CSRF-
      protected route handler directly outside Playwright (the only route
      tested that way is the signature-authenticated Stripe webhook, which
      has no session/CSRF to satisfy); building that harness was judged
      out of scope for this focused pass, and the e2e test already
      exercises the real boundary end to end.
- [x] Price/stock updates go through domain services and write movements +
      audit (Phase 4).
- [x] A text-typed SKU cell's value — including a leading zero — survives
      an `.xlsx` import exactly as entered (test); the honest, documented
      limit (a *numerically*-formatted cell has already lost the leading
      zero before the file is read — not something any reader can recover)
      is also tested, not just asserted in prose.
- [x] `ImportJob` / `ImportJobRow` history is queryable in the admin UI
      (the checklist previously named `ImportBatch`/`ImportRow` — the
      actual models are `ImportJob`/`ImportJobRow`, reconciled here) — **new
      this pass**: paginated, newest-first, with a job detail view and a
      downloadable error report; see below.
- [ ] Crash mid-commit leaves the DB consistent (chunked-transaction test) —
      **partially addressed (2026-10-01), explicitly not fully closed.**
      `commitImport`'s transaction design was first inspected fresh from
      source (not assumed from memory): each row's `applyRow` runs inside
      its own `db.$transaction`, wrapped in a per-row `try/catch` that
      marks the row `FAILED` and continues the loop — there is no
      whole-commit transaction, and no prose guarantee existed anywhere in
      the code before this pass. A new integration test injects a real,
      reproducible failure (a Prisma unique-constraint violation from an
      in-file option-combination clash, not a mock) partway through a
      3-row commit and proves: the earlier row stays committed; the
      failing row's own transaction rolls back completely (zero partial
      writes — no variant row, no inventory row left behind); a later row
      is still attempted and succeeds (the loop does not abort); the job
      ends `COMPLETED` (not `VALIDATED`), so `commitImport` correctly
      refuses to run again on that same job (`job_wrong_state`); and the
      **actually-supported** retry path — a brand-new import of a
      corrected file — fills the gap via idempotent upsert-by-SKU with no
      duplicate rows and no drift in the two previously-succeeded
      variants' real (non-zero, explicitly set) on-hand quantity. **This
      is injected-exception coverage of existing per-row transaction
      behaviour, not proof of recovery from a real process crash** (e.g.
      the Node process being killed or losing power mid-commit) — no test
      in this codebase exercises that scenario, and none was added here.
      The checkbox stays unchecked for that reason; the underlying
      transaction-safety and safe-retry behaviour it was really guarding
      against is now evidenced.
- [x] e2e: upload → preview → commit → summary; and the error-report path
      — **automated**, covering both CSV and XLSX — new this pass, the
      first e2e coverage the import flow has ever had (previously zero,
      an explicitly-flagged gap). This is distinct from, and does not
      substitute for, the user's own manual review. **CSV commit** was
      manually verified earlier, in the **Phase 4/5 live pre-flight
      (2026-09-03** — see that section): preview (zero writes) → commit
      (2 products created, no partial write) → re-import of the same file
      (idempotent: 0 created / 2 skipped) → formula-injection and
      in-file duplicate-SKU/option rejection, all against live
      PostgreSQL. The **recent (2026-09-30)** CSV manual review (below)
      covered import history, the error-report download, and opening it
      in Excel — it did **not** include a new CSV commit click. **XLSX**:
      preview manually verified only; commit/history/error-report for
      XLSX have no manual review yet (see "Manual review" above).
- [x] Full verification pipeline green for this sub-milestone (see Test
      evidence below); the phase as a whole is not yet complete — see
      "Remaining gaps" immediately below.

**Remaining gaps (reconciled 2026-10-01, against current implementation
and evidence — not a plan, nothing here has been implemented yet):**

1. **Manual review of XLSX commit, history, and the error-report
   download** — unchanged by this pass, still open. The preview path is
   manually verified (see "Manual review" above); commit/history/
   error-report are not. Needs no implementation, only the user's own
   next session against the real dev server.
2. ~~Three small, low-risk XLSX test-coverage gaps~~ — **closed
   2026-10-01**: in-file duplicate-SKU detection, idempotent re-import,
   and the compressed-upload-size cap are now independently tested
   against real `.xlsx` files (integration) and, for the upload-size cap,
   also against the real HTTP boundary (e2e). See the acceptance criteria
   above and the new sub-milestone below for exact evidence. No defect was
   found in any of the three — the shared CSV-proven code path held.
3. **Crash mid-commit leaves the DB consistent (chunked-transaction
   test)** — **narrowed, not closed, 2026-10-01**. A new test proves the
   real per-row transaction behaviour under a genuine injected exception
   (see the unchecked acceptance box above for the full description); it
   does not, and cannot, prove recovery from an actual process crash
   (process killed / power loss mid-commit) — that scenario remains
   completely untested, here and everywhere else in this codebase, and
   would need different infrastructure (e.g. killing a child process
   mid-write and inspecting the DB afterward) to exercise honestly.
4. **An `.xlsx` template writer** — explicitly out of scope, not a gap
   against what was asked for (the user confirmed one is not required for
   this increment); listed here only so the unchecked box above isn't
   mistaken for an oversight.
5. **No unit-level test of `preview/route.ts` (or the commit/errors
   routes) in isolation** — this codebase has no established pattern for
   testing a `guardMutation`/CSRF-protected route handler directly (only
   the signature-authenticated Stripe webhook is tested that way, and it
   has no session/CSRF to satisfy). The real HTTP upload-size boundary is
   still proven, but via Playwright driving the actual browser form (see
   item 2 above), not a route-level unit test. Building that harness was
   judged out of scope for this focused pass; flagged here as an honest
   limitation rather than silently left unmentioned.
6. *(Pre-existing, not introduced by any Phase 10 pass)* the original
   scope line at the top of this section still says "column mapping" —
   no column-mapping UI exists or has ever existed (CSV never had one
   either); the importer instead requires exact canonical/alias header
   names. Not reported as a blocking gap since no acceptance checkbox
   requires it and none ever claimed it was done — flagged here only for
   the same reason the `ImportBatch`/`ImportRow` naming was reconciled
   earlier in this document: so the written scope and the real
   implementation don't quietly drift apart.

**Recommended next milestone**: the user's own manual review of XLSX
commit, history, and the error-report download (item 1) — the only
remaining item that needs no further implementation, just the user's next
session against the real local dev server, exercising the same steps
already manually verified for CSV. Everything implementation-shaped that
was reasonably in scope for a focused, test-only pass is now closed (item
2) or has had its real boundary honestly narrowed down to exactly what
remains untested (items 3 and 5). Item 4 (`.xlsx` template writer) stays
explicitly deferred with no dependency on anything else here. Not
implemented yet, per instruction.

### Sub-milestone: import history, downloadable error reports, and e2e coverage (2026-09-30)

**Scope delivered** — read-only, fully additive; `previewImport`/
`commitImport` in `product-import-service.ts` were not modified:

- **`src/server/import/import-queries.ts`** (new) — `listImportJobs`
  (paginated, newest-first, `orderBy: [{createdAt:"desc"},{id:"desc"}]` —
  a stable tie-breaker for when two jobs share a `createdAt` millisecond,
  a pattern not previously used anywhere in this codebase's other admin
  lists, which are all single-column `orderBy` and can silently skip or
  repeat rows across pages on a tie), `getImportJob` (throws the existing
  `ImportFileError("job_not_found", …, 404)` for a missing job),
  `listFailedImportRows` (paginated by the row's own unique `rowNumber` —
  no tie-breaker needed there), and `buildImportErrorReportCsv`. Every one
  of these four functions calls `requirePermission(actor, "import.run")`
  independently — none rely on a caller (page, route, or each other)
  having already checked.
- **A real, previously-undetected counting gap, found while building
  this**: `commitImport`'s own `ImportJob.failedRows` field only counts
  failures found during its own commit-time loop over `PENDING` rows — a
  row that already failed at **preview** time (e.g. a duplicate SKU within
  the file) is marked `FAILED` and never touched by commit, so it was
  silently excluded from that stored count. Confirmed with a real
  end-to-end run: a job with one genuine preview-time failure showed "0
  failed" in the existing commit-summary UI. Not a bug introduced here,
  and `commitImport`'s logic was deliberately left unchanged (out of
  scope) — instead, `getImportJob`/`listFailedImportRows` query
  `ImportJobRow.status = FAILED` directly (ground truth) rather than
  trusting that field, and `import-runner.tsx`'s commit-summary panel now
  separately tracks the preview step's own accurate error count
  (`previewErrorCount`, captured before `onCommit` clears `preview`) and
  adds it to `committed.counts.failed` — the two are disjoint by
  construction, so the sum is the true total, computed entirely
  client-side with no change to what the server returns.
- **CSV error report** (`GET /api/admin/import/products/[jobId]/errors`,
  new route) — one CSV line per (row, error) pair: row number, SKU,
  column, error code, message, and the original cell value for that
  column (from the row's stored `rawData`). Every cell goes through the
  same `toCsv`/`escapeForCsvOutput` helpers the CSV template already uses
  — proven with a deliberately formula-injection-shaped error message in a
  mocked unit test, not just asserted. Bounded: reads failed rows in
  50-row pages up to `IMPORT_MAX_ROW_COUNT` (the importer's own per-file
  row cap — a job can never legitimately have more failed rows than that),
  never one unbounded query — proven by asserting on the actual number and
  shape of the underlying `findMany` calls, not just the output.
  `content-disposition: attachment`, `cache-control: no-store, private`.
- **Two new admin pages** — `/admin/catalog/import/history` (paginated
  list: file, format, status, counts, actor, timestamps) and
  `/admin/catalog/import/history/[id]` (detail: full job summary, a
  paginated failed-rows table, and the error-report download link when
  there are any failed rows). Both independently re-check
  `requirePermission(user, "import.run")` (redirecting to `/admin/catalog`
  on failure, matching the existing import page's own behaviour) — the
  page-level check is not assumed to be redundant with the query
  functions' own checks, and vice versa. A missing job renders Next's
  `notFound()` (404), not a crash. An unfinished (not yet committed) job
  is shown with its real status and an explicit "not finished yet" notice,
  never fabricated finished-looking counts.
- **Links added** from the existing import page and its commit-summary
  panel: "View all import history", each recent-import row, "View
  details", and "Download error report (CSV)" (only shown when there is
  at least one failed row, using the corrected total above).

**Real defect found and fixed during this pass**: while validating the
error-report link's visibility with a genuine preview-time failure (see
above), the link failed to appear at all — `committed.counts.failed` read
0 for a job that genuinely had one failed row. Fixed as described above
(client-side, additive, no server-side behaviour change) and covered by
the e2e test that exercises exactly this real scenario, not a contrived
one.

**Test evidence (2026-09-30)**: unit **+4**
(`tests/unit/import-error-report.test.ts` — formula-injection escaping,
CSV quoting, multi-error rows, bounded pagination via mocked Prisma) —
running total **384/384**, 51 files. Integration **+8**
(`tests/integration/import-history.integration.test.ts`, real DB —
authorization matrix across all four query functions × unauthenticated/
STAFF/CUSTOMER/MANAGER, missing-job handling, a job with zero failed rows,
an unfinished/never-committed job's preview-time failure already being
visible, a genuine duplicate-SKU failure's count matching across
`getImportJob`/`listFailedImportRows`/the CSV export independent of
`ImportJob.failedRows`, job-list pagination with a real same-millisecond
tie, and failed-row pagination/export across more than one internal page)
— running total **165/165**, 17 files. E2E **+2**
(`tests/e2e/import-history.spec.ts`, dedicated port-3100 server, isolated
`TEST_DATABASE_URL`, synthetic test-owned fixtures only — one consolidated
MANAGER login covers upload → preview → commit → summary → history list →
detail → CSV download → a zero-failure job → a missing job's 404; a
second test checks unauthenticated denial on the history page and the
error-report route with no login at all, costing nothing against the
suite's shared login-rate-limit budget) — running total **30/30**, 12
files. `tsc --noEmit`, `eslint .` both clean. The user's own manually
started PowerShell dev server on port 3000 was left running throughout —
confirmed via a direct, read-only request against it after all automated
work finished.

**Manual review (2026-09-30, by the user, against the real local dev
server)** — the observed facts, recorded as reported:

- Import history opened and displayed dated entries without errors.
- An existing job with two failed rows was opened.
- Its error-report CSV downloaded successfully and opened in Excel.
- The report showed source rows 2 and 3, column `price`, error code
  `required`, message "Price is required."

**This local milestone — import history and the downloadable error
report — is accepted**, on the basis of the automated evidence above and
this manual review. This acceptance covers only that milestone; it does
not mark Phase 10 as a whole complete (XLSX remains, below), and does not
extend to anything beyond what was actually reviewed.

**Not claimed**: this review did **not** include a new manual CSV commit
click — only history list/detail, the error-report download, and opening
it in Excel, as listed above. Manual commit evidence for CSV exists
separately, from the **Phase 4/5 live pre-flight (2026-09-03** — see that
section): a live preview → commit → re-import round trip against real
PostgreSQL, predating and independent of this review; it is not
attributed to this pass. XLSX support (template, reader, writer, and its
own formula-injection review) is **not implemented** — see "Next separate
increment" below; this was explicitly kept out of this sub-milestone.
Crash-mid-commit consistency is not newly tested by this pass — it was
already outside this pass's read-only scope (`commitImport` itself was not
touched). This sub-milestone does not itself constitute Phase 10's
completion — only the history/error-report/e2e gaps identified in the
prior review pass are closed.

### Sub-milestone: XLSX product import (2026-09-30)

**Dependency choice: `exceljs` (MIT, v4.4.0)** — checked against its
current npm registry metadata, GitHub repository, and README before
adopting:

- **Rejected `xlsx` (SheetJS)**: the npm-published package is frozen at
  0.18.5, which is vulnerable to prototype pollution (CVE-2023-30533) and
  a ReDoS (CVE-2024-22363). The maintainer stopped publishing fixed
  versions to npm after that — the only way to get a patched version
  (0.19.3 / 0.20.2) is the maintainer's own CDN, outside the project's
  normal `npm install` / lockfile workflow. That's a supply-chain posture
  this project shouldn't take on for one dependency.
- **`exceljs`** is npm-published, MIT-licensed, actively maintained
  (current major version, ~1,775 commits), with exactly one historical
  advisory (a 2018 XSS, fixed in 1.6.0 — long irrelevant). It is a pure
  JS/XML/zip reader with no VBA engine (cannot execute a macro even if one
  were present) and no documented formula-evaluation or external-link
  behaviour (confirmed by reading its README — it is silent on both,
  consistent with being a static parser, not an Office automation engine).
- **`npm audit` after installing it** flags one new transitive finding:
  `uuid < 11.1.1` (GHSA-w5hq-g745-h8pq, moderate — a missing buffer-bounds
  check in `uuid`'s `v3`/`v5`/`v6` functions **when a caller supplies an
  explicit output buffer**). Checked `exceljs`'s own source
  (`lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js`): it imports only
  `uuid`'s `v4` function, which the advisory does not implicate at all, and
  never passes a buffer argument. Not exploitable through this dependency
  as used. `npm audit`'s suggested "fix" (downgrading `exceljs` to 3.4.0,
  ten-plus major versions back) would be a worse outcome than the
  near-zero residual risk and was not taken. The other `npm audit` findings
  (`next`, `brace-expansion`, `deepmerge-ts`/`@prisma/config`) pre-date
  this change and are unrelated to it.
- **`jszip` was added as an explicit direct dependency** (pinned
  `3.10.1`, matching exactly what `exceljs` itself already depends on —
  reusing the same library `exceljs` uses internally, not a second,
  differently-behaving zip parser) for the bounded archive-decompression
  guard below. **Evidence, not just an audit result**: a web search cross-
  referencing the GitHub Advisory Database and Snyk found two real,
  historical `jszip` CVEs — CVE-2021-23413 (prototype pollution via a
  crafted entry name, fixed in 3.7.0) and CVE-2022-48285 (directory
  traversal in `loadAsync`, fixed in 3.8.0). The installed version
  (confirmed directly from `package-lock.json`/`node_modules`, not
  assumed from the semver range) is `3.10.1` — above both fix versions.
  Independent of the version check: this project's own usage never writes
  an entry's name to the filesystem (an entry's name is read only to
  stream its *content* and to name it in an error message), so even an
  unpatched copy's directory-traversal mechanism would not be reachable
  through how this code uses the library. `npm audit` reported no
  `jszip`-specific finding, consistent with — but not the sole basis
  for — this assessment.

**Scope delivered** — fully additive to the existing format-neutral
pipeline; `previewImport`/`commitImport`/`parseProductRow`/`applyRow` in
`product-import-service.ts` were not modified in any way; XLSX gets the
exact same validation and business rules by construction, not by
re-implementation:

- **`src/server/import/xlsx-parser.ts`** (new) — `parseXlsx`, producing
  the identical `ParsedTable`/`ParsedRow` shape `parseCsv` does.
  `row-source.ts`'s `RowSource.parse` is now `ParsedTable |
  Promise<ParsedTable>` (XLSX parsing is unavoidably async — unzip + XML
  parse) and `previewImport` now `await`s it; this is the only change to
  previously-shipped code outside the import module itself.
- **Worksheet handling, documented and enforced, never a silent guess**:
  exactly one worksheet may contain data (`actualRowCount > 0`) — used
  regardless of its position in the workbook. **More than one populated
  worksheet is refused outright**, naming every sheet that has data —
  never silently reading one and discarding another's data. The header is
  always that worksheet's row 1, identical to CSV's "first line is the
  header" rule.
- **Formula cells are explicitly rejected with a clear, hard row-level
  error — never evaluated, never trusted, and never just a soft
  warning a row could otherwise sail through on.** A formula-typed cell's
  cached `result` is never read; its value becomes empty AND the row
  carries a `formula_cell_rejected` error naming the column
  (`ParsedRow.formatErrors`, merged into the row's errors in
  `previewImport` — see below). This is deliberately **stronger** than
  CSV's own leading-character handling: CSV neutralizes *suspicious text*
  and lets ordinary field validation decide whether the resulting gap
  matters, which is fine for a merely-suspicious-looking string, but a
  genuine XLSX formula cell is a different, more serious kind of thing — if
  it only produced a soft warning, a formula sitting in an *optional*
  column (e.g. `description`) would import successfully with that field
  silently blank and no error anywhere, exactly the "silently ignored"
  outcome this requirement rules out. Proven for both a required field
  (`price`) and an explicitly optional one (`description`) — see Test
  evidence.
- **No macros, no external links**: `.xlsm` remains explicitly refused
  (see below) before this module ever runs, and `exceljs` has no VBA
  engine regardless; loading a workbook is a pure in-memory buffer parse
  with no network or filesystem I/O for external references.
- **Bounded resource use, including decompression — not just the
  compressed upload size.** The original pass of this sub-milestone relied
  on `IMPORT_MAX_FILE_SIZE_BYTES` (the *compressed* upload size) as the
  only decompression-cost bound — a real gap, found by the user's own
  review before manual acceptance, not by this implementation's own
  testing (see "Real gap found and fixed" below). Fixed by
  `src/server/import/xlsx-archive-guard.ts`'s `assertBoundedXlsxArchive`,
  which runs **before `exceljs` ever loads the workbook** and enforces,
  while actually streaming each ZIP entry's decompression (not from ZIP
  central-directory metadata, and not only after an entry is fully
  materialized): at most 100 archive entries; at most 50 MB decompressed
  per entry; at most 100 MB decompressed in total. The stream is paused
  and the promise rejects the instant either byte limit is crossed —
  confirmed against `jszip`'s own `NodejsStreamOutputAdapter` source that
  pausing genuinely halts further inflate work, not just further delivery
  of already-inflated bytes. `MAX_IMPORT_COLUMNS` (200) and
  `IMPORT_MAX_ROW_COUNT` continue to bound the row/column counts
  afterward, as before. **Documented remaining limitation**: this bounds
  decompressed memory/byte volume, not wall-clock CPU time for a
  pathological entry *structure* within those byte limits — the
  entry-count cap and the pre-existing upload-size cap are the mitigation
  for that, not a dedicated timeout; a dedicated wall-clock timeout for
  this specific step was not added this pass.
- **Text SKUs, including leading zeros, are preserved** when the source
  cell is genuinely text-typed. The honest limit — a cell the spreadsheet
  itself formatted as a number has already lost the leading zero before
  this file is ever read, and no reader can recover that — is documented
  in the admin upload instructions, not left for someone to discover the
  hard way.
- **`.xlsx` only**: `.xls`, `.xlsm`, and `.ods` remain explicitly refused
  with a clear message naming the two accepted formats. `row-source.ts`'s
  `KNOWN_UNSUPPORTED` list was narrowed accordingly (removing `.xlsx` from
  the refusal list, now that it has a real reader registered).
- **Admin UI**: the import page's heading, instructions, and file-input
  `accept`/label now cover both formats, with the worksheet rule, the
  text-SKU/leading-zero note, the formula-rejection behaviour, and the
  accepted-formats list stated plainly. The CSV template remains the only
  downloadable template, accepted as input either way — no `.xlsx`
  template writer was built this pass (confirmed not required).
- **History and the error report work unchanged for an XLSX-sourced job**
  — `ImportJob.sourceFormat` already existed and is simply `"XLSX"`
  instead of `"CSV"`; the history list, detail page, and CSV error-report
  download needed zero code changes to work correctly for XLSX, proven
  end to end (see Test evidence).

**Real gap found and fixed (second pass, same day, before manual
acceptance)**: the user's own review of the first pass — not this
implementation's own testing — correctly identified that a compressed-
upload-size cap does not bound decompression resource use for a ZIP-based
format, and that checking row/column counts only *after* `exceljs` fully
loaded the workbook checks "after full allocation," not "while
decompressing." Both are addressed above (`xlsx-archive-guard.ts`, run
before `exceljs` loads anything, enforced on the live decompression
stream). Also addressed in this pass: formula-cell handling was upgraded
from a soft warning to an explicit, hard row-level error (see above) after
re-examining whether the original neutralize-and-continue design could
let a formula in an optional field "silently" produce no visible signal.

**Test evidence (2026-09-30)**: unit **+16**
(`tests/unit/import-xlsx-parser.test.ts`, 16 cases — the original 15 for
valid imports, header normalisation, text-SKU leading-zero preservation,
the worksheet rules, malformed input, and the row/column caps, plus this
pass's formula-rejection cases updated to assert the hard
`formatErrors`/`formula_cell_rejected` error instead of the old soft
warning, and a new case proving every formula column on a multi-formula
row is flagged; plus 1 case in `import-row-source.test.ts` resolving
`.xlsx` to the new reader) **and +7**
(`tests/unit/import-xlsx-archive-guard.test.ts` — a single-entry bomb
rejected by byte count, not just elapsed time, and proven to resolve in
well under 5 seconds rather than fully inflating 60 MB first; several
entries individually under the per-entry cap but over the total cap; too
many archive entries; a non-ZIP file; a normal real workbook passing
cleanly; and `parseXlsx` itself rejecting a bomb with the archive guard's
own error code, never an `exceljs` parse error) — running total
**408/408**, 53 files. Two existing tests (`import-row-source.test.ts`,
`import-product-service.test.ts`) that previously asserted `.xlsx` was
refused were updated to assert that for `.xlsm` instead — `.xlsx`
graduated to supported, the underlying "unsupported format gets a clear
message" behaviour they test is unchanged for the formats still refused.
Integration **+5**
(`tests/integration/product-import-xlsx.integration.test.ts` — the
original 4 (a real `.xlsx` file mapping to a product with two variants
exactly as CSV would, a text-typed leading-zero SKU surviving end to end
into the database, a missing-price row failing with the identical
validation error CSV produces at the correct source row and appearing
correctly through `getImportJob`/`listFailedImportRows`/the CSV
error-report export) with the formula test strengthened to assert the
explicit `formula_cell_rejected` error (not just the required-field
side-effect), plus 1 new case proving a formula in an *optional* field is
still explicitly rejected, never silently imported with that field blank)
— running total **170/170**, 18 files. E2E: unchanged this pass (no new
browser scenario was needed — the archive-bounding and formula-hardening
changes are both exercised at the parser/service layer; the existing
`tests/e2e/import-history.spec.ts` XLSX scenario continues to pass
unmodified) — **30/30**, 11 files. `tsc --noEmit`, `eslint .` both clean.
The user's own manually started PowerShell dev server on port 3000 was
left running throughout, confirmed untouched (same PID) after all
automated work finished; dev business data was not touched.

**Not claimed**: an `.xlsx` template writer was not built (confirmed not
required this increment). Decompression is now bounded by actual
streamed byte count (entries and total), not just the compressed upload
size — but wall-clock CPU time for a pathological entry *structure*
within those byte limits is not independently bounded by a timeout; see
the documented limitation above. Crash-mid-commit consistency remains
untested (still out of scope — `commitImport` itself was not touched).
**Manual review (2026-09-30, by the user, against the real local dev
server, a real Excel-saved workbook)** — the observed facts, recorded as
reported:

- The downloaded CSV template was opened in Excel and saved as
  `Taek-Test.xlsx` using Excel Workbook format.
- Clearing the first sample row's price and uploading the workbook
  produced "Price is required" in the preview.
- Adding a second worksheet with "Test" in cell A1, saving, and
  re-uploading produced: "This file has data on 2 worksheets
  (taek-shops-product-import-templ, Sheet1). Put all data on a single
  worksheet and remove or empty the others, then re-upload." (the first
  sheet's name is Excel's own 31-character truncation of the
  template's original filename — observed, not something this code
  controls or needed to special-case).

**Both manual checks passed.** This covers the preview path only — **no
Commit was clicked**. Manual verification of XLSX commit, import history,
and the error-report download is **not claimed**: those paths remain
verified only by the automated unit/integration/e2e evidence reported
above, not by this manual review. The CSV versions of commit/history/
error-report **were** manually reviewed and accepted earlier (see the
import-history/error-report sub-milestone above) — that acceptance does
not extend to the XLSX source format.

**Manual review steps still remaining**: with the same or a similar
`.xlsx` file, click Commit and confirm the created/updated counts match
the preview; open `/admin/catalog/import/history` and confirm the job is
listed with format `XLSX`; open its detail page and confirm the failed
row and actor/status/timestamps render correctly; download its error
report and confirm it opens in Excel with the expected row/column/error
content — the same checks already completed manually for CSV.

### Sub-milestone: focused XLSX test coverage and injected-failure-recovery pass (2026-10-01)

**Scope delivered** — test-only, no production code changed.
`previewImport`/`commitImport`/`parseXlsx`/`xlsx-archive-guard.ts` were not
modified; `commitImport` was inspected fresh from source first, as
instructed, before any failure-recovery test was written.

- **`tests/integration/product-import-xlsx.integration.test.ts`**, three
  new tests (file went from 5 to 8, then 9 with the item below):
  - Idempotent re-import of an identical `.xlsx` file: `created: 0,
    updated: 0, skipped: 2` on the second commit, exactly one product and
    two variants afterward (no duplicates), and — checked against a real
    non-zero on-hand quantity set via `adjustInventory` beforehand, not
    the trivial 0-on-creation case — no inventory drift. New `ImportJob`
    rows from the second run are asserted to exist (2 total), explicitly
    as expected audit trail, not as something to avoid.
  - In-file duplicate SKU in an `.xlsx` file: flagged
    `duplicate_sku_in_file` at preview time, the non-duplicate row still
    commits, same behaviour as the existing CSV test.
  - Oversized `.xlsx` file at the real pipeline entry point: calls
    `previewImport` directly (via the same `vi.stubEnv` +
    `vi.resetModules` + dynamic re-import pattern already used in
    `tests/unit/import-xlsx-parser.test.ts`, since `serverEnv` is parsed
    once at module load) with a file sized past a lowered
    `IMPORT_MAX_FILE_SIZE_BYTES`, asserting `file_too_large`.
- **A real bug found in this pass's own first draft, fixed before
  reporting**: the idempotent-re-import test initially read
  `inventoryItem?.onHand`, a field that does not exist on `InventoryItem`
  (the real column is `quantityOnHand` — confirmed by reading
  `prisma/schema.prisma`). The read silently evaluated to `undefined` on
  both sides of the before/after comparison, so the assertion passed
  without checking anything. Caught before this was reported as evidence,
  fixed to read the real field, and strengthened to set a known non-zero
  value first (`adjustInventory`) so the comparison is real. This was a
  defect in this pass's own test code, not in `product-import-service.ts`
  or any other production file.
- **New failure-recovery test, injected-exception coverage (explicitly not
  crash-recovery coverage)** — added to the same XLSX integration file.
  `commitImport` was re-read fresh first (see acceptance criteria above
  for the exact, previously-undocumented transaction design this
  confirmed: one `db.$transaction` per row, a per-row `try/catch` that
  marks a failure `FAILED` and continues the loop — no whole-commit
  transaction). The test builds a 3-row `.xlsx` file where row 2 is
  individually valid (passes every preview-time check) but genuinely
  violates the real `@@unique([productId, optionSignature])` constraint
  against row 1's option combination — a reproducible `applyRow` failure
  from real application logic, not a mock. It asserts: row 1 stays
  committed; row 2 produces zero rows (its transaction rolled back in
  full, no partial write); row 3 (after the failure) still commits (the
  loop does not abort); the job ends `COMPLETED`, so re-calling
  `commitImport` on that same job id is correctly refused
  (`job_wrong_state`) — there is no "retry the same job" path; and the
  actually-supported retry — a brand-new import of a corrected file — adds
  the missing row with no duplicates and no change to the two
  already-succeeded variants' real on-hand quantity (set to known
  non-zero values beforehand). **What this proves and does not prove,
  stated plainly**: it proves the real, already-existing per-row
  transaction isolation and the real supported-retry workflow, under a
  genuine exception thrown mid-loop. It does **not** prove recovery from
  an actual process crash (the Node process killed, or power lost,
  mid-commit) — no test anywhere in this codebase exercises that, and none
  was added here; that would need different infrastructure entirely (e.g.
  killing a child process mid-write and inspecting the DB state
  afterward).
- **`tests/e2e/import-history.spec.ts`** — one new step appended to the
  existing, already-consolidated MANAGER login (no new login added, no
  change to the suite's shared login-rate-limit budget): an oversized CSV
  buffer (5,000,001 bytes, simplest to construct exactly past the default
  5,000,000-byte `IMPORT_MAX_FILE_SIZE_BYTES`) is uploaded through the
  real browser form and the rendered error message
  (`/exceeds the 5,000,000 byte limit/i`) is asserted. This drives the
  actual HTTP upload boundary — real cookies, real CSRF token attached by
  the app's own client code — reaching the genuine check in
  `src/app/api/admin/import/products/preview/route.ts` before any
  CSV/XLSX-specific parsing runs. A CSV buffer was used because it is
  format-neutral: the check fires on raw `file.size` before the route
  branches on format, so this is equally valid evidence for an oversized
  `.xlsx` upload hitting the identical line. **No route-level unit test
  was added or attempted** — confirmed via inspection that this codebase
  has no precedent for testing a `guardMutation`/CSRF-protected route
  handler directly outside Playwright (the only route tested that way is
  the signature-authenticated Stripe webhook, which authenticates via an
  HMAC header and has no session/CSRF to satisfy); building that harness
  from scratch was judged out of scope for a focused, test-only pass. This
  is recorded as an honest limitation (see "Remaining gaps," item 5), not
  claimed as closed.

**No production defect was found by any test in this pass.** Every new
test passed against the existing, unmodified implementation; the one real
bug found (above) was in this pass's own test code and was fixed before
being reported, per instruction not to report unverified claims.

**Test evidence (2026-10-01)**: the full required regression suite was
run, not just the new tests in isolation. `tsc --noEmit`: clean. `eslint
.`: clean. Unit: **408/408**, 53 files (no change in count from the prior
pass — these additions were integration/e2e only). Integration:
**174/174**, 18 files (up from the prior pass; the XLSX file alone is now
9/9, up from 5). E2E: **30/30**, all spec files, run after clearing a
stale `.next-e2e` build-cache lock (`rm -rf .next-e2e`, this environment's
known, non-code Windows/OneDrive file-lock flake — never resolved by
touching a process) — includes the new oversized-upload step inside the
existing `import-history.spec.ts` login.

**Dev server note**: a direct, read-only check against
`http://localhost:3000/` after this pass's regression run found nothing
listening (connection refused on both `localhost` and `127.0.0.1`). None
of this pass's commands touch port 3000 — all test runs (`vitest`,
`playwright`) use the isolated test database and, for e2e, a separate
server on port 3100 (`playwright.config.ts`) — so this was not caused by
this work. It is reported here rather than silently assumed away; the
user's own PowerShell session may need restarting before the next manual
review step above can be carried out.

**Phase 10 local acceptance assessment**: with this pass, every acceptance
criterion that was reasonably testable without new scope or new test
infrastructure now has real, format-matched automated evidence, and every
remaining gap is narrowed to a precisely-stated, honestly-reported
limitation rather than an untested assumption:

- Closed this pass: XLSX idempotent re-import, XLSX in-file duplicate-SKU
  detection, the compressed-upload-size cap for XLSX (at both the service
  entry point and the real HTTP boundary via e2e), and injected-exception
  coverage of `commitImport`'s per-row transaction/retry behaviour.
- Still open, by design or by honest limitation, not oversight: the user's
  manual review of XLSX commit/history/error-report (needs only the next
  session, no implementation); real process-crash recovery (no test
  anywhere in this codebase attempts it); a route-level unit test for the
  upload-size boundary (no precedent exists for testing a CSRF-protected
  route handler outside Playwright); the `.xlsx` template writer
  (explicitly out of scope per earlier instruction); and the pre-existing
  "column mapping" scope-text drift (cosmetic, not a missing feature).
- **Phase 10 as a whole is not yet complete** — it was not claimed to be
  before this pass and is not claimed to be now. The one remaining item
  with no automated substitute is the user's own manual review of XLSX
  commit/history/error-report.

**Recommended next milestone** (unchanged from above, repeated here for
this pass's own record): the user's manual review of XLSX commit,
history, and the error-report download — the only remaining step, and the
only one this pass could not itself perform. Not implemented yet, per
instruction.

---

## Launch-readiness tracking (started 2026-10-01)

Cross-cutting, outside the numbered phases above — tracks work identified by
a launch-gap review against actual code, not a new phase. Phase 10's local
milestone acceptance (above) rests on the reported regression evidence and
the previously-recorded manual review; it is **project acceptance**, not an
independent security/code audit or a production-readiness claim, and
nothing here changes that.

**Next.js critical advisory — verified and patched (2026-10-01).** An
earlier report in this project's own working notes cited `next@16.3.8` as
the fix; the OFFICIAL advisory was re-checked directly before touching any
dependency, and that citation was **imprecise** — corrected here:

- **Advisory**: [GHSA-vcvr-r3jv-pc5j](https://github.com/vercel/next.js/security/advisories/GHSA-vcvr-r3jv-pc5j)
  (CVE-2026-94545), Critical, CVSS 9.5 — RCE in the Node.js `next/og`
  `ImageResponse` implementation when attacker-controlled values reach SVG
  content/attributes/styles.
- **Affected**: `>= 16.2.0 < 16.3.6`. **Patched**: `16.3.6` (the actual
  minimum patched version — not `16.3.8`, which was simply the latest
  release `npm audit` happened to offer).
- **Installed before this pass**: `16.3.4` (confirmed in both
  `package.json` and `package-lock.json`'s resolved `node_modules/next`
  entry) — inside the affected range.
- **Exploitability note**: this app never imports `next/og` or
  `ImageResponse` anywhere (confirmed by search) — the vulnerable code path
  is not reachable through this app's own usage. Patched anyway since the
  fix is a 2-patch-version bump with no breaking changes.
- **Fix applied**: `next` and `eslint-config-next` pinned to the exact
  patched version, `16.3.6` (the smallest supported fix, not a jump to
  latest). No blanket `npm audit fix`, no unrelated dependency changes.
  `npm audit` before → 7 vulnerabilities (2 moderate, 4 high, **1
  critical**); after → 6 (2 moderate, 4 high, **0 critical**) — the
  remaining four (`brace-expansion`, `deepmerge-ts` via Prisma's own
  tooling, `uuid` via `exceljs`) are unrelated, pre-existing, and
  deliberately left untouched per instruction.
- **Verification after the actual change**: `tsc --noEmit` clean, `eslint
  .` clean, unit **408/408**, integration **174/174**, `next build`
  (production) succeeded, e2e **30/30**.

**Password-reset UI — implemented, local-delivery only (2026-10-01).** The
service layer (`src/server/auth/verification.ts`: token issuance, single-
use consumption, expiry, no-enumeration, session revocation, weak-password
rejection) and both API routes
(`/api/auth/password-reset`, `/api/auth/password-reset/confirm`) already
existed and were already unit-tested — only the UI pages were missing.
Added, reusing the existing services/routes/conventions unchanged:

- `/password-reset` (request) and `/password-reset/confirm` (set new
  password, via `?token=`) — both minimal client forms matching
  `login-form.tsx`'s existing style. A "Forgot password?" link was added to
  the login form.
- The request form always shows the identical generic confirmation
  regardless of whether the email matched an account, matching the
  service's own no-enumeration guarantee.
- The confirm form never echoes the token beyond the one hidden submit
  field, never logs it, and shows the server's own generic "invalid or
  expired" message for an invalid, expired, AND already-used token alike —
  it does not and cannot distinguish them, matching the server.
- **A real characteristic found while wiring this up (not a bug in
  existing code)**: a too-short/too-long password is rejected by the
  route's own Zod schema (`passwordResetCompleteSchema`) *before*
  `completePasswordReset` ever runs, returning a different JSON error
  shape (`error.details` as Zod's `flatten()` object) than a password that
  passes that shape check but fails the richer server-side policy (common
  password, contains name/email, etc. — `WeakPasswordError.details` as a
  plain string array). The confirm page now handles both shapes so a
  simple "too short" mistake shows a specific, useful reason instead of a
  generic "Invalid request."
- **Real email delivery is explicitly still pending** — `src/server/auth/mailer.ts`
  remains `NoopMailer` by design this pass; this feature is **not**
  claimed production-ready. A customer using this flow with a real
  provider not yet configured has no way to actually receive the link;
  only the UI and the already-working token mechanics were in scope here.
- **Test evidence**: one new e2e spec
  (`tests/e2e/password-reset.spec.ts`), real browser against the isolated
  e2e database. No mailer test-seam was added — every token is minted
  directly via the existing `createVerificationToken` (the same function
  `requestPasswordReset` itself calls before handing off to the
  never-exercised mailer), sidestepping the undelivered-email problem
  entirely rather than fabricating a transport. Covers: the login page's
  link; identical generic response for an unknown vs. a real email;
  invalid token; expired token (directly backdated in the test DB);
  reused/already-consumed token; weak password (both the too-short and the
  policy-rejected shapes); mismatched confirmation (client-side); and a
  successful reset, verified by checking the stored password hash
  directly rather than a real `/api/auth/login` browser POST — deliberately,
  to spend **zero** of the e2e suite's shared, IP-keyed login rate-limit
  budget (adding one real login here is exactly what broke
  `product-images.spec.ts`'s login on the first attempt at this spec, by
  pushing the suite's total over the limit within one run; removing it was
  the fix, consistent with this project's standing rule to always reduce
  usage rather than touch the limiter). Full regression re-run after this
  fix: unit **408/408**, integration **174/174**, e2e **31/31**
  (30 pre-existing + 1 new), `tsc`/`eslint` clean.

**Abandoned-checkout stock reservation — inspected, read-only, not
implemented.** `placeOrder` reserves stock (`reserveStockTx`) at the moment
a `PENDING` order is created, **before** any payment attempt. Confirmed by
reading the schema and the order/payment/webhook code directly:

- **No expiry exists anywhere in this path.** `Order` has no `expiresAt`
  (or equivalent) field — only `Session` and `VerificationToken` do. There
  is no cron/scheduler and no sweep script for orders (the two that exist,
  `emails:dispatch` and `images:cleanup-uploads`, are unrelated).
- **The only two things that release a `PENDING` reservation today**: (1)
  a real Stripe webhook — `payment_intent.payment_failed` or
  `payment_intent.canceled` — which only fires from an actual failed
  attempt or an explicit cancellation, never from mere inaction; (2) an
  admin manually choosing "Cancel" on the order (`PENDING → CANCELLED` is
  in `ADMIN_ORDER_STATUS_TRANSITIONS`), which goes through the same
  `releaseReservationTx` path.
- **The real gap**: a customer who starts checkout (reserving stock) and
  simply closes the tab — never confirming payment, never explicitly
  cancelling — leaves that reservation held indefinitely. Stripe does not
  auto-cancel an unconfirmed PaymentIntent created via the Payment Element
  flow this app uses (unlike a Checkout Session, which has a built-in
  `expires_at`), so no webhook ever arrives for this case either.
- **Why a naive age-based release is unsafe, concretely**: an order's
  `createdAt` age alone cannot distinguish "abandoned" from "the customer
  is mid 3-D Secure / slow network / about to confirm." Releasing stock
  based on age alone risks a genuine race: a late
  `payment_intent.succeeded` webhook could arrive for an order whose stock
  was already released and resold, producing exactly the oversell this
  system was built to prevent.
- **The smallest change that stays safe, proposed not implemented**: a
  scheduled job that (a) finds `PENDING` orders past a generous age
  threshold, (b) for each, asks **Stripe directly** for that PaymentIntent's
  current true status (never trusting local age alone), and (c) if and
  only if it is still genuinely cancelable, calls Stripe's own
  `paymentIntents.cancel` — which Stripe itself refuses atomically if the
  PaymentIntent has already succeeded or is processing, closing the race
  by construction rather than by any locking this app would need to
  invent. Canceling via Stripe is what triggers the **existing, already
  idempotent, already-tested** `payment_intent.canceled` webhook handler to
  perform the actual release — so this needs a new *trigger* only, zero
  new release/business logic. No Stripe call was made and no code was
  written for this during this inspection, per instruction.

**Launch checklist — corrections to the prior assessment**:

- **Reservation recovery** (the gap above) and **verified backup
  restoration** (not just a backup existing) are now treated as **required
  launch checks**, not deferrable nice-to-haves.
- **Managed-provider backups are plan-dependent, not free or already
  verified.** The prior assessment's assumption that a managed Postgres
  provider "would close most of this gap for free" is **not confirmed** —
  automated backups, retention length, and point-in-time recovery vary by
  provider and by paid tier; this must be checked against whichever
  specific provider/plan is actually chosen, and a real restore must
  actually be exercised once, not assumed from a feature list.
- **All scope deferrals proposed in the prior assessment remain
  unapproved** (Phase 11 admin tax/shipping UI, Phase 12 i18n, Phase 13's
  Docker/CI, full observability, automated backup tooling, the abandoned-
  order sweep above) — nothing has been decided, only proposed.
- **The prior hosting recommendation (Vercel) is provisional, not a
  decision** — it was not assessed against this app's actual production
  requirements: the real database host/plan, whether product-image object
  storage needs to stay private vs. public, how the two existing
  dispatch/cleanup scripts would actually be scheduled on that platform,
  and whether anything in this codebase assumes a long-lived Node process
  (vs. a serverless request lifecycle) that a serverless host would break.
  None of those have been checked yet.

### Sub-milestone: real email provider — Resend, behind both mailer interfaces (2026-10-01)

**Provider evaluation, against current official sources (not assumed from
training data):**

- **API**: [`POST https://api.resend.com/emails`](https://resend.com/docs/api-reference/emails/send-email),
  `Authorization: Bearer <key>`, JSON body `{from, to, subject, html,
  text}`, success `200 {"id": "<uuid>"}`.
- **Idempotency**: an [`Idempotency-Key` request header](https://resend.com/docs/dashboard/emails/idempotency-keys)
  (max 256 chars) is de-duplicated by Resend for **24 hours**. This
  project's own `OrderEmail.idempotencyKey` (`cuid()`) fits well inside
  that limit, and the outbox's own retry schedule (30s base backoff, 30
  minute cap, 5 attempts) stays well inside the 24-hour window in normal
  operation — documented honestly as a limit, not assumed to hold under an
  operator manually re-triggering a job more than a day later.
- **Errors**: [documented status codes](https://resend.com/docs/api-reference/errors) —
  401/403 (bad key, unverified/restricted domain) and 400/422 (request
  validation) are never retryable; 429 and 5xx are. This classification is
  now wired into the outbox's own retry decision (below).
- **SDK/runtime**: the official Node SDK requires Node ≥20; this project
  requires Node ≥22.18.0 (`package.json` `engines`), so compatibility is
  not a concern either way. **The SDK was deliberately NOT installed** —
  this integration calls Resend's REST API directly with the built-in
  `fetch` (Resend's own documented approach for non-Node-SDK runtimes),
  which needs no new dependency and, more importantly, satisfies
  `src/server/notifications/*`'s existing constraint of staying resolvable
  by `scripts/dispatch-emails.ts`, a plain `node` CLI script that cannot
  resolve an npm package import the way Next's/Vitest's bundler can (the
  same reason that tree is relative-import-only already).
- **Domain verification**: requires adding a sending domain (a subdomain
  is Resend's own recommendation, e.g. `updates.taekshops.ca`, not the
  apex) and publishing the DNS records Resend's dashboard generates for
  it — see the owner checklist below. No concrete blocker found; proceeded
  with implementation.

**What was built** — `src/server/email/` (new, zero internal imports of
its own, so it is reachable from both the `@/`-alias world and the
relative-import-only `notifications/` tree):

- `resend-client.ts` — `sendViaResend()`, a thin raw-`fetch` wrapper.
  Never logs or includes the recipient/subject/body in a thrown error —
  only Resend's own response about the *request's* acceptance. A 10-second
  timeout via `AbortSignal.timeout`; classifies every documented status
  code as retryable or not (above).
- `transport.ts` — `resolveEmailTransport()`, the ONE fail-closed gate
  both mailer interfaces share, so they can't silently drift apart on when
  a real transport may run:
  - Refuses `"resend"` during any Vitest run (`NODE_ENV=test` or `VITEST`
    set) **even if real credentials are present** — automated tests cannot
    reach Resend no matter what a local `.env` contains.
  - Refuses an **unset** `EMAIL_TRANSPORT` in production
    (`NODE_ENV=production`) — never silently defaults to a local preview
    transport in a real deployment. An **explicit** non-`"resend"` choice
    in production is honoured, not rejected (needed for the e2e harness
    below, which also runs `NODE_ENV=production`) — the danger guarded
    against is silence, not any particular explicit value.
  - Refuses `"resend"` without both `RESEND_API_KEY` and
    `EMAIL_FROM_ADDRESS` set.
  - **A real bug in this rule was caught by the e2e run itself, not
    assumed correct**: the first version rejected ANY non-`"resend"` value
    under `NODE_ENV=production`, which meant the e2e harness's own safety
    override (`EMAIL_TRANSPORT=local-preview`, below) made the e2e server
    throw on every request touching a mailer — masked at first because
    `request-form.tsx` deliberately ignores the backend's response status
    for no-enumeration reasons, so the e2e test still passed while the
    server logged an unhandled error. Caught by reading that log line, not
    by the test's own assertions; fixed by narrowing the rule to "unset",
    re-verified by re-running the full e2e suite clean and confirming a
    real local preview file was written for the password-reset flow.
- `src/server/auth/mailer-templates.ts` (new) — renders the password-reset
  and email-verification messages (subject/HTML/text) from the raw token
  and `NEXT_PUBLIC_APP_URL`. **Email verification's link points to
  `/verify-email?token=...` — no page exists at that path yet** (only the
  pre-existing `POST /api/auth/verify-email` route); email verification is
  also not enforced anywhere in this app today (no login/checkout path
  checks `emailVerifiedAt`). Flagged here honestly rather than silently
  implied complete — out of scope for this email-delivery-focused pass.
- `src/server/auth/mailer.ts` — rewritten with three implementations
  (`ResendMailer`, `LocalPreviewMailer` — new, writes to
  `.local/email-previews/` like the order-mailer one already did, replacing
  `NoopMailer` as the default — and `NoopMailer`, kept for explicit
  `EMAIL_TRANSPORT=noop`), selected via `resolveEmailTransport()`. The
  previous `export const mailer` singleton became a lazy `getMailer()` /
  `__setMailer()` seam (mirroring `order-mailer.ts`'s existing pattern);
  `verification.ts`'s two call sites updated accordingly — no change to
  `requestPasswordReset`/`completePasswordReset`'s own behaviour, generic
  responses, or token security.
- `src/server/notifications/order-mailer.ts` — added `ResendOrderMailer`,
  using the job's own stable `idempotencyKey` as Resend's
  `Idempotency-Key` header. `getOrderMailer()`'s resolver updated the same
  way; `LocalPreviewOrderMailer` unchanged.
- `src/server/notifications/email-outbox.ts` — `resolveEmailJobFailure`
  now fails a job **immediately** (skipping the remaining backoff
  schedule) when the error is a `ResendApiError` marked non-retryable
  (bad key, unverified domain, a malformed request) — these can never
  succeed on a later attempt with the same configuration, so burning
  through `maxAttempts` (~15 minutes of backoff) before surfacing a real
  misconfiguration was pure waste. Every other failure kind (network
  errors, timeouts, 429/5xx, a plain `Error`) retries exactly as before —
  behaviour-unchanged for anything that isn't a confirmed-permanent
  provider rejection.
- **Test isolation, layered, so automated tests cannot send real email
  even if real credentials happen to exist**: (1) `resolveEmailTransport()`
  itself refuses `"resend"` under `NODE_ENV=test`/`VITEST` — covers every
  Vitest run regardless of `.env`; (2) `tests/integration/helpers/setup.ts`
  now also installs a `FakeMailer` (new, mirroring `FakeOrderMailer`)
  globally for the whole integration suite, alongside the existing
  `FakeOrderMailer` override — defense in depth, not reliance on (1) alone;
  (3) `playwright.config.ts`'s `webServer.env` now also forces
  `EMAIL_TRANSPORT=local-preview` (and blanks `RESEND_API_KEY`/
  `EMAIL_FROM_ADDRESS`) for its dedicated e2e server, the same role its
  existing `PAYMENT_GATEWAY=e2e-fake` and blanked `S3_*` overrides already
  play — this is the one that actually matters there, since that process
  runs `NODE_ENV=production`, which layer (1)'s test-run check does not
  catch.
- **`.env.example`** documents `EMAIL_TRANSPORT`, `RESEND_API_KEY`,
  `EMAIL_FROM_ADDRESS` — no real values, consistent with every other
  provider section in that file.

**Not claimed**: exactly-once delivery (unchanged from the outbox's own
existing, honest "at-least-once" note — Resend's idempotency key narrows
the unsafe window to the rare case of a retry more than 24 hours after
first attempt, it does not eliminate it). "Sent" means Resend's API
*accepted* the request, never proof of inbox delivery — bounces and spam
placement are invisible to this integration, by design, stated in
`resend-client.ts`'s own module comment. No real send has been attempted
against a real Resend account — that requires the owner's own account and
domain verification (below) and is explicitly not done here. The scheduler
that would run `npm run emails:dispatch` on an interval in production
remains unimplemented — an explicit pending activation step, not
attempted this pass. No public HTTP endpoint for dispatch was added or
exists; the script remains CLI-only.

**Test evidence (2026-10-01)**: new unit tests — `resend-client.test.ts`
(11: success including the exact request shape and both idempotency-key
cases, 401/403/422 non-retryable, 429/5xx/network/timeout retryable, a 2xx
with no id treated as a failure not a silent success, no recipient/body
ever in a thrown message), `email-transport.test.ts` (12: every rule
above, including the production/explicit-value fix), `mailer-resend.test.ts`
(7: `ResendMailer` field passthrough for both email types, safe failure
logging, `getMailer()`'s resolution across all three transports plus the
`__setMailer` override), `resend-order-mailer.test.ts` (5: the
`ResendOrderMailer` equivalents), plus 3 new cases in the existing
`email-outbox.test.ts` for the new fast-fail-on-non-retryable behaviour —
**37 new tests**. Full regression re-run after the actual changes (twice —
once before the fail-closed fix above, once after): `tsc --noEmit` clean,
`eslint .` clean, `next build` (production) succeeded, unit **445/445**
(57 files, up from 408), integration **174/174** (18 files, confirming the
new global `FakeMailer` override introduces no behaviour change for any
existing test), e2e **31/31** (unchanged count from the prior pass — no
new e2e spec added this time, the existing `password-reset.spec.ts` is
what surfaced and then confirmed the fail-closed fix), with a real local
preview file confirmed written to `.local/email-previews/` for that run's
password-reset flow (checked directly, not assumed from the test passing).

**Owner setup checklist** — account and DNS only; no code changes needed
once this is done, just setting the three env vars above in the real
deployment's environment:

1. Create a Resend account (resend.com) and add a sending domain — Resend's
   own recommendation is a subdomain (e.g. `updates.taekshops.ca`), not
   the bare `taekshops.ca` apex.
2. In Resend's dashboard, open that domain's **Records** tab and add the
   exact DNS records it generates at your DNS host — typically:
   - An **MX** record (bounce handling) on the sending subdomain.
   - An **SPF TXT** record on the sending subdomain.
   - A **DKIM TXT** record (`resend._domainkey.<subdomain>`).
   Copy/paste these exactly as shown — don't retype them. Verification is
   usually complete within ~15 minutes of the records propagating.
   (A DMARC record is good practice but not itself required by Resend to
   verify a domain.)
3. Create an API key in Resend scoped to **Sending access** (not **Full
   access**) for this app's use.
4. In the real deployment's environment (never committed, never pasted
   into chat), set:
   - `EMAIL_TRANSPORT=resend`
   - `RESEND_API_KEY=<the key from step 3>`
   - `EMAIL_FROM_ADDRESS=` a "Name <email@your-verified-subdomain>" address
     on the domain verified in step 2.
5. **What remains unverified until an explicitly authorized real-delivery
   test**: every behaviour above was proven against mocked provider
   responses and a local preview transport — no email has actually been
   sent through a live Resend account by this work. The first real send
   (triggered deliberately, e.g. a real password-reset request against a
   real deployment with the above configured) is the first point any of
   this is confirmed against the real provider, and should be watched in
   Resend's own dashboard the first few times.

**Recommended next concrete step** *(superseded by the sub-milestone
below — the email-verification UI gap it referenced is now closed; the
owner activation steps remain the actual next step)*.

### Sub-milestone: email-verification UI, and a transport-gate hardening pass (2026-10-01)

**Why before owner activation**: the previous pass's email template already
rendered a link to `/verify-email?token=...` with no page behind it, and
its own fail-closed production rule had a real, found-not-assumed gap
(below) — both closed before asking the owner to flip on real delivery.

**Inspected first, as instructed**: `/api/auth/verify-email` (route +
`confirmEmailVerification`/`consumeVerificationToken` service), and
whether anything in this app currently triggers the FIRST verification
email at all. **It does not** — there is no self-signup flow anywhere in
this app (only `/api/admin/users`, admin-created accounts), nothing calls
`requestEmailVerification` from any route or page, and `emailVerifiedAt`
is never set automatically nor checked by any login/checkout path. This is
pre-existing, not introduced here. Consequence: **no resend-verification
UI was added** — building one would imply a "send" capability that doesn't
exist yet, which is speculative scope beyond "complete the missing
flow," not something "required by the existing flow" as instructed.

**What was built**:

- **`/verify-email`** (`src/app/verify-email/`) — follows
  `/password-reset/confirm`'s conventions, with one deliberate structural
  difference: **loading the page (a GET) renders a "Verify email" button
  and does nothing else.** Only clicking it fires the actual
  `POST /api/auth/verify-email` (the same `guardMutation`-protected route
  that already existed) — which is the only thing that calls
  `confirmEmailVerification` and burns the token. This is the explicit
  defense against automated email-link scanners (many corporate mail
  gateways GET-prefetch every link in an incoming message): a GET alone
  can never consume a one-time token here, by construction, not by
  convention. (Password-reset's confirm page already had this property
  incidentally, because a password field needs real input a scanner can't
  provide; verify-email has no such field, so the button is the only thing
  standing in for it — made explicit rather than relying on an accident of
  a different flow's shape.)
- Success/invalid states match password-reset's own model exactly: the
  server's generic `InvalidTokenError` message is shown for an invalid,
  expired, AND already-used token alike, never distinguished, matching
  `consumeVerificationToken`'s own refusal to distinguish them. No token
  is logged, echoed into any error message, or sent anywhere other than
  the one `POST` body.

**Two real gaps found during this pass, not assumed — both fixed in
`src/server/email/transport.ts`:**

1. **The production base-URL check that should have existed didn't.**
   `NEXT_PUBLIC_APP_URL` defaults to `http://localhost:3000` when unset
   (`src/server/config/env.ts`) — in every environment, including
   production. Nothing previously stopped a real Resend send from going
   out with a `localhost` link a real customer could never use.
   `resolveEmailTransport()` now refuses to select `"resend"` unless
   `NEXT_PUBLIC_APP_URL` is set to something other than
   `localhost`/`127.0.0.1`/`[::1]` — checked against the raw env var, not
   the Zod-defaulted `clientEnv`, specifically so an unset var can't
   silently read as "fine." This check fires whenever `"resend"` is
   selected, not only under `NODE_ENV=production` — a developer
   deliberately testing a real send from a local machine would hit the
   identical bug, so the check isn't scoped to production alone.
2. **The prior pass's production rule was looser than it should have
   been, exactly as flagged**: it allowed ANY explicit non-`"resend"`
   value under `NODE_ENV=production` (needed so the e2e harness's own
   `EMAIL_TRANSPORT=local-preview` override wouldn't break — that server
   also runs `NODE_ENV=production`). But `NODE_ENV` alone cannot
   distinguish that harness from a real live deployment that was
   explicitly, but mistakenly, configured the same way. Fixed by requiring
   independent proof of the e2e harness specifically — mirroring
   `src/server/domain/payments/index.ts`'s own `getPaymentGateway()`
   pattern for the identical problem: BOTH `E2E_DIST_DIR === ".next-e2e"`
   AND `DATABASE_URL === TEST_DATABASE_URL` must hold, not either alone. A
   real production deployment (lacking both) is now rejected even if it
   explicitly sets `EMAIL_TRANSPORT=local-preview`/`noop` — only an unset
   value was rejected before this fix.
   - **The exact deployment check, stated precisely, not overclaimed**:
     `isKnownE2eHarness()` in `transport.ts` is what gates this. It has
     been verified against every configuration this test suite can
     construct (`tests/unit/email-transport.test.ts`). **It has not been
     exercised against an actual live deployment** — none exists yet — so
     "this blocks a real misconfigured production rollout" is a tested
     property of the code, not a claim that it has ever actually stopped
     one. The same residual risk `getPaymentGateway()` already accepts and
     documents applies identically here: an operator could deliberately
     set both markers in a real deployment to defeat this check; that is
     a pre-existing, accepted trade-off of this exact pattern, not a new
     gap introduced by reusing it.

**Strengthened `tests/e2e/password-reset.spec.ts`**, per instruction that a
generic success message alone must not be trusted as proof of backend
delivery: it now reads the actual `.local/email-previews/` directory
(`tests/e2e/helpers/email-previews.ts`, new — real files on the filesystem
both the Playwright runner and the spawned e2e server share) before and
after each request, asserting a new `password-reset` file appears for the
real account and that NONE appears for the unknown one — the UI shows the
identical message either way, so only this filesystem check actually
proves which request the backend really acted on. **This is precisely the
check that would have caught the transport-gate bug found in the previous
pass** (the e2e server's own safety override being rejected by production
rule) — that bug was real but invisible to the test as it existed then,
because the UI deliberately ignores the backend's response status for
no-enumeration reasons.

**Test evidence (2026-10-01)**: new e2e spec `tests/e2e/verify-email.spec.ts`
(1 test, multiple scenarios: no token, invalid token, the GET-doesn't-consume
proof — three page loads plus a full navigation away and back, all before
the one real confirm click — reused/already-consumed token, expired
token); `tests/e2e/password-reset.spec.ts` strengthened in place (same
test count, stronger assertions); 6 new unit cases in
`tests/unit/email-transport.test.ts` (localhost rejection ×3, the
tightened e2e-harness-or-reject production rule ×2, one unaffected-path
regression). Full regression re-run after the actual changes: `tsc
--noEmit` clean, `eslint .` clean, `next build` (production) succeeded,
unit **451/451** (57 files, up from 445), integration **174/174**
(unchanged — this pass touched no integration-reachable code), e2e
**32/32** (31 pre-existing + verify-email's 1 new spec).

**Not claimed**: email verification still has no trigger anywhere in this
app (see above) — this pass makes the LINK work, not the sending of a
first verification email; that remains entirely unbuilt, deliberately, per
instruction not to add unrequested scope. No real send was attempted. The
production scheduler for `npm run emails:dispatch` remains unactivated.

**Recommended next concrete step** *(superseded below — the abandoned-
checkout reservation gap this referenced is now closed; domain/DNS and
real-send activation remain pending, explicitly owner-side, not blocking
local implementation)*.

**Domain purchase status**: the owner has no domain yet and will purchase
one later. Recorded here as a pending owner task — real email activation
and the owner checklist above cannot proceed without it, but nothing in
this codebase is blocked waiting for it.

### Sub-milestone: abandoned-checkout reservation recovery (2026-10-02)

**Inspected first, as instructed** — `src/server/orders/checkout-service.ts`
(`placeOrder` reserves stock the instant a `PENDING` order is created,
before any payment attempt), `payment-service.ts` (`startPayment`,
`finalizeFromPaymentIntentTx`/`finalizeFailureTx` — the one existing
idempotent completion path, already shared by the webhook and the
return-page's `verifyPaymentStatus`), `order-inventory.ts` (the
`PENDING→CANCELLED` transition and its `release` inventory effect, and
`releaseReservationTx`'s own `InventoryItem` row-lock +
idempotency-key-checked-via-`movementExists` mechanism — the actual source
of exactly-once release, confirmed by reading it directly rather than
assumed), and the full `PaymentGateway` interface + its three
implementations (`StripePaymentGateway`, `E2EFakePaymentGateway`, the
integration tests' `FakeStripeGateway`). Confirmed: nothing previously
released a `PENDING` order's reservation except a real Stripe
failure/cancel webhook or a manual admin cancel — exactly the gap recorded
in the prior launch-gap review.

**Reuses the existing idempotent path for everything it can — no new
stock-release implementation was written.** The new module,
`src/server/orders/order-expiry.ts`, calls the SAME
`finalizeFromPaymentIntent` the webhook and return-page already use for
every outcome it can apply to (succeeded, canceled) — its own internal
re-check of the order's current state inside a transaction is what makes a
payment that actually succeeded in the exact window this sweep was
checking a safe no-op, not a new guard built for this pass. The one truly
new case — no PaymentIntent anywhere, not locally and not at the provider —
cancels through `applyOrderStatusTransitionTx`, the identical primitive the
admin "Cancel" button and the webhook's own failure path already use.

**Expiry semantics** (also documented in `order-expiry.ts`'s own module
comment, which is the source of truth going forward):

- Configurable floor: `ORDER_EXPIRY_MINUTES` (default 60,
  `src/server/config/env.ts`) — only `PENDING`+`UNPAID` orders at least
  this old are even considered. A `PAID` order is excluded by the query
  itself and can never be touched by this module.
- **No PaymentIntent locally**: checked against the provider directly
  (`PaymentGateway.findPaymentIntentForOrder`, new — Stripe Search API by
  `metadata['orderId']`) before concluding nothing exists — closes the
  exact race named in the brief: `startPayment`'s own
  `createPaymentIntent` call can succeed at the provider while the
  following local `Payment` row write never lands (a crash/network drop
  between the two). Found → backfills the missing `Payment` row, then
  reconciled exactly like a linked payment. Genuinely absent at the
  provider too → cancelled directly, no provider round trip needed.
- **Linked payment, `"processing"`**: never touched, regardless of age —
  an active settlement is never interrupted.
- **Linked payment, still payable**
  (`requires_payment_method`/`requires_confirmation`/`requires_action`):
  never released "because it's old." `PaymentGateway.cancelPaymentIntent`
  (new) is called explicitly; only once the PROVIDER's response confirms
  cancellation is the local state finalized. Stripe's own real behaviour —
  mirrored exactly in the test double — definitively refuses to cancel a
  PaymentIntent that has already moved to `succeeded`/`processing`, which
  is what makes a race lost at the last moment safe: the refusal itself
  tells this code to re-ask for current truth rather than ever assuming.
- **Ambiguous provider failure** (network/timeout —
  `PaymentGatewayError.ambiguous`): the order is left completely untouched;
  the next sweep retries. Never treated as "no answer means safe to
  cancel."
- **Payment success racing with expiry**: reconciled as paid (stock
  committed, not released) whenever the provider reports success at check
  time — proven directly in the test suite, not just assumed from
  `finalizeFromPaymentIntent`'s reuse.

**Unresolved, stated honestly, not glossed over**: under a genuinely
concurrent double-run of this sweep against the SAME no-PaymentIntent
order, both runs can read the order as still `PENDING` before either
commits (the identical class of race every other status-transition caller
in this codebase already tolerates for the same underlying reason — see
`order-inventory.ts`'s own header comment) — so both MAY record a
duplicate `order.expired` audit row. **The actual inventory release does
NOT double-apply**; that guarantee comes from `releaseReservationTx`'s
pre-existing `InventoryItem` row lock + idempotency-key check, proven
directly by this pass's own concurrency tests (below), not merely assumed
from that mechanism's reuse.

**Gateway interface additions** (`src/server/domain/payments/`) —
implemented in all three existing implementers:

- `cancelPaymentIntent(id, idempotencyKey)` — `StripePaymentGateway` calls
  `stripe.paymentIntents.cancel()` directly; the test double
  (`tests/integration/helpers/payments.ts`'s `FakeStripeGateway`) mirrors
  Stripe's real, documented refusal behaviour (a definitive, non-ambiguous
  error for `succeeded`/`processing`) rather than a simplified always-
  succeeds stub, specifically so this module's race-handling logic is
  exercised against realistic behaviour, not a convenient fiction.
  `E2EFakePaymentGateway` gets a harmless stub (not exercised by any
  existing e2e spec).
- `findPaymentIntentForOrder(orderId)` — `StripePaymentGateway` uses
  Stripe's Search API (documented indexing latency of up to ~1 minute,
  acceptable since this is only ever called for orders already past the
  expiry floor); the fake scans its own in-memory intent map by metadata.

**No schema change.** Every field this module reads or writes
(`Order.status`/`paymentStatus`/`createdAt`, `Payment.providerPaymentId`
and the fields backfilled onto a new `Payment` row) already existed. One
new audit action constant (`order.expired`, purely additive — a string, not
a migration) and one new optional env var (`ORDER_EXPIRY_MINUTES`).

**CLI entry point**: `npm run orders:expire-abandoned` →
`scripts/expire-abandoned-orders.ts`. **Not scheduled anywhere — an
explicit pending activation step**, exactly like `emails:dispatch`/
`images:cleanup-uploads`; no public HTTP endpoint was added, protected or
otherwise. **One real, disclosed deviation from those two scripts**: this
one runs via `tsx` (added as a new dev dependency), not plain `node`. Those
two scripts' target modules were purpose-built as a small, standalone,
relative-import-only tree specifically so Node's own built-in TypeScript
stripping (no bundler) could reach them; the order/payment domain this
script needs is pervasively woven through the app via the `@/` path alias,
and converting that whole tree to relative-only imports to match would
have been a large, invasive change to core, already-tested payment/order
logic for a purely mechanical reason — judged out of scope for a bounded
pass. `tsx` resolves `tsconfig.json`'s `paths` the same way Next's/Vitest's
own tooling already does, so `order-expiry.ts` could be written as
ordinary application code, reusing the existing machinery directly.
**Manual CLI smoke-test note**: a direct interactive invocation of this
script against the isolated test database was attempted for extra
confidence beyond the test suite, and hit an environment-variable
propagation quirk specific to this one debugging shell session (confirmed,
via a minimal reproduction, to be unrelated to path-alias resolution,
which works correctly — `tsx` was proven to correctly locate, load, and
execute the aliased `env.ts` module). Not chased further since the actual
verification path for this module is the integration suite below, which
does not go through `tsx` at all and passed cleanly; flagged here rather
than silently omitted.

**Test evidence (2026-10-02)**: new integration suite
`tests/integration/order-expiry.integration.test.ts`, **11 tests**, every
one against a real order created through the real `placeOrder` checkout
flow and a real (behaviorally-accurate, not simplified) `FakeStripeGateway`
— no mock of this module's own logic:

- No PaymentIntent at all → cancelled directly, reservation released,
  audited; a `PAID` order is excluded by the query and left untouched.
- The no-PaymentIntent race: an orphaned already-succeeded intent is found
  and reconciled as paid (never cancelled) — the backfilled `Payment` row
  is asserted to actually exist afterward; an orphaned still-payable intent
  gets the full confirmed-cancellation treatment.
- A linked, still-payable intent is actively cancelled and only then
  released; a `"processing"` intent is left completely untouched regardless
  of age.
- Payment success racing with expiry: reconciled as paid (stock committed)
  when the provider reports success at check time; a separate case proves
  an order already fully reconciled by something else is excluded from the
  sweep's own query entirely — the strongest form of safe no-op.
- An ambiguous (network/timeout-shaped) cancel failure leaves the order and
  reservation completely untouched on the first sweep, then succeeds
  cleanly on a second — proving "preserved" and "retried safely" as two
  separate, both-verified properties, not one assumed from the other.
- **Exactly-once inventory release**, the headline correctness property:
  two sweeps run concurrently (`Promise.all`) against the SAME
  no-PaymentIntent order, and separately against the SAME linked-payment
  order — in both cases, exactly one `RELEASE` `StockMovement` row exists
  afterward and on-hand stock is restored to precisely its original value,
  regardless of both runs reporting having acted.

Full regression re-run after the actual changes: `tsc --noEmit` clean,
`eslint .` clean, `next build` (production) succeeded, unit **451/451**
(unchanged — no new unit tests this pass; the new gateway methods are
exercised through the integration suite's real `FakeStripeGateway`,
consistent with how `createPaymentIntent`/`retrievePaymentIntent` were
already tested, never in isolation against real Stripe), integration
**185/185** (174 pre-existing + this pass's 11), e2e **32/32** (unchanged —
this pass added no browser-reachable surface).

**Not claimed**: no real Stripe call was made by this pass — every test
runs against `FakeStripeGateway`/the isolated test database. The real
`StripePaymentGateway.cancelPaymentIntent`/`findPaymentIntentForOrder`
implementations are plumbing, written to Stripe's documented API shape,
but — consistent with every other real-Stripe code path in this project —
not exercised against a live Stripe account by this pass; that remains the
owner's own Test-Mode verification to perform, same as every other payment
path here. The production scheduler for `npm run orders:expire-abandoned`
(and the still-separately-unscheduled `emails:dispatch`/
`images:cleanup-uploads`) remains unactivated — three scripts now share
the identical "written, tested, not yet scheduled anywhere" status.

**Phase 10/launch-readiness local implementation status** — corrected
wording, this pass: the code-level work this engagement's launch-gap
review identified as locally completable (real email transport, the
email-verification UI, the Next.js critical CVE, abandoned-checkout
reservation recovery) is **implemented and tested**. That is a narrower
claim than "launch-ready" and the two are not being equated here. **Domain
purchase, DNS verification, real email activation, and production
scheduling are deferred activation dependencies — owner- and
deployment-side actions still to be taken — not requirements this pass
has resolved.** Nothing has actually been activated: no real email has
been sent, no scheduler runs anywhere, no production deployment exists.
"Tested" means verified against isolated fixtures and fake providers;
it does not mean "verified in the environment where it will actually run,"
which remains explicitly future work.

### Sub-milestone: two verification gaps closed in the abandoned-checkout milestone (2026-10-03)

> **CORRECTION (2026-10-06): item 1 below ("race fixed") is WITHDRAWN as insufficient** — a local re-read and post-write compensation cannot survive a crash between provider success and local persistence. Superseded by *durable payment-creation coordination* (next sub-milestone below). Item 2 (CLI run, `tsx` dependency) stands.

**1. Stripe coordination for `findPaymentIntentForOrder` — inspected against
official documentation, a real race found and fixed, not merely
re-asserted.**

- **Exact mechanism, verified against
  [Stripe's own Search docs](https://docs.stripe.com/search)**: the Node
  SDK's `paymentIntents.search()` calls Stripe's Search API
  (`GET /v1/payment_intents/search`), which is explicitly documented as
  **eventually consistent**: *"Don't use search for read-after-write
  flows... data is searchable in under 1 minute under normal operating
  conditions."* A second, separate caveat also applies and was not
  accounted for in the previous pass: *"Data mismatches... the Search API
  filters using a cached version of the PaymentIntent status, but returns
  data based on the latest version"* — meaning even a successful search
  HIT can carry a stale `status` field.
- **The concrete race, found by inspecting `startPayment` fresh, not
  assumed**: `startPayment` calls `gateway.createPaymentIntent()` (a real
  provider write) and only THEN writes the local `Payment` row. Nothing
  about the abandoned-checkout sweep's age floor prevents a customer from
  returning to pay on an already-stale order at the exact moment a
  scheduled sweep also processes it — the floor bounds how OLD an order
  must be to be considered, not how recently a NEW, legitimate payment
  attempt might be starting on that same old order. Before this fix,
  `findPaymentIntentForOrder` returning nothing was treated as sufficient
  proof to cancel directly — exactly the overclaim the brief named:
  **"a lookup returning no results" is not proof of provider absence**,
  only of "not found by this particular check, which has its own
  blind spots."
- **The fix — smallest change that closes it, not a new subsystem**:
  `cancelDirectly` (`src/server/orders/order-expiry.ts`) now re-checks
  the LOCAL `Payment` table's existence, FRESH, inside the very same
  transaction that would cancel the order — the final gate immediately
  before an irreversible action. This is deliberately not "query Stripe
  Search again" or "wait and retry": a local Postgres read has **no**
  indexing lag at all, so it correctly catches a `startPayment` call whose
  `db.payment.create` has already committed, regardless of whether
  Stripe's own search index has caught up to the matching
  `createPaymentIntent` call. The new outcome is preserved, not cancelled
  (`"preserved_payment_started"`). Symmetrically, `startPayment` itself
  (`src/server/orders/payment-service.ts`) now re-verifies the order is
  still payable immediately after writing its `Payment` row, and — if a
  cancellation won that race instead — cancels its own just-created
  PaymentIntent via the existing `cancelPaymentIntent` gateway method
  rather than handing a doomed `clientSecret` to the customer.
- **A found-via-search orphan is now always re-verified with a real,
  non-search `retrievePaymentIntent` call before any reconciliation
  decision** — directly closing the "cached status" caveat above, not
  just the indexing-lag one.
- **What remains, stated honestly**: the narrow window between
  `createPaymentIntent` returning and `db.payment.create` actually
  committing inside `startPayment` itself (a single INSERT's latency,
  typically single-digit milliseconds) is not fully eliminated — if the
  sweep's re-check lands in that exact instant, it would still see no
  `Payment` row. `startPayment`'s own symmetric re-check is what catches
  this case from the other side, so it is not left unguarded, but it is a
  narrower, honestly-disclosed residual window, not a claim of zero race.
- **Deterministic proof, not assumption**: two new integration tests use
  a test-only hook (`ExpirySweepHooks.beforeCancelDirectly`,
  `StartPaymentHooks.afterPaymentRowCreated` — both no-ops unless a test
  sets them) to interject the REAL `startPayment` function, and a REAL
  concurrent cancellation, at the EXACT point each race window exists,
  proving the stated ordering — "sweep sees no intent, payment creation
  resumes, cancellation competes with that creation" — rather than merely
  asserting the fix should work. The existing orphan tests (an intent
  created at the provider with no local write) are unchanged and still
  pass — confirmed, not assumed, after these changes.

**2. The real CLI entry point — actually run, not inferred from the
service's own integration tests.**

- **The reported environment issue was a false alarm in the verification
  method, not in the code**: re-investigated by constructing a minimal,
  dependency-free reproduction. The actual cause: this project's `.env`
  wraps its values in literal double quotes, and the earlier shell-based
  extraction (`sed`/regex) captured those quote characters AS PART of the
  value when setting `DATABASE_URL` for a manual run — producing a
  string that starts and ends with `"`, which `z.url()` correctly
  rejected as malformed. Confirmed directly: once the extraction strips
  the surrounding quotes, `tsx` resolves the `@/` path alias and loads
  `env.ts` identically under both `npx tsx` and the local `.bin` binary,
  in both git-bash and PowerShell. Not a tsx bug, not a path-resolution
  bug — a one-off mistake in how a manual shell command built an
  environment variable, now corrected for future manual verification.
- **The actual command was run**, `npm run orders:expire-abandoned`,
  against `TEST_DATABASE_URL` with `PAYMENT_GATEWAY=e2e-fake` +
  `E2E_DIST_DIR=.next-e2e` (the project's own existing fail-closed
  double-check, reused rather than inventing a new one — see
  `src/server/domain/payments/index.ts`'s `getPaymentGateway()`), making
  **zero** external Stripe calls:
  - Seeded two genuinely stale, real `PENDING`/`UNPAID` orders (via the
    real `addToCart`/`placeOrder` services, not hand-built rows) with no
    payment attempt, backdated 2 hours past the default 60-minute floor.
  - **First run**: exit code **0**. Output: `scanned 2 stale PENDING/UNPAID
    order(s): 2 cancelled_no_payment_intent`. Verified directly against the
    database (not just the log line): both orders `CANCELLED`, inventory
    restored to its original on-hand value with zero reserved, exactly
    2 `RELEASE` `StockMovement` rows (one per order), exactly 2
    `order.expired` audit rows.
  - **Second run (immediately after, no changes in between)**: exit code
    **0**. Output: `scanned 0 stale PENDING/UNPAID order(s) (none)` —
    bounded processing confirmed (it only ever acts on genuine candidates,
    never repeats work). Database re-checked: byte-identical to after the
    first run — still exactly 2 release movements, no duplicates, safe
    repeat execution proven directly, not inferred.
  - All synthetic fixtures deleted afterward. **A genuine residue bug was
    found and fixed during this verification, unrelated to the feature
    itself**: an earlier, failed attempt at this same manual seed (before
    a script error was fixed) had left one orphaned product/variant/
    inventory-item behind with no backing stock movement, which made the
    PRE-EXISTING, unrelated `reconcileAllInventory reports ok for a clean
    database` integration test fail on the next full regression run.
    Found by investigating that failure rather than dismissing it,
    traced to the exact leftover row, deleted, and the full integration
    suite re-confirmed green (187/187) afterward — not left for a future
    session to discover.
- **The runtime-dependency gap named in the brief was real and is now
  fixed**: `tsx` had been added to `devDependencies` — which a typical
  production install (`npm ci --omit=dev` or equivalent) does not
  install, meaning the scheduled job would have failed to even start in
  a real deployment. Moved to `dependencies`. Verified directly, not
  assumed: `npm ls tsx --omit=dev` confirms `tsx@4.23.15` resolves in the
  production-only dependency tree.
- **Exact scheduler/runtime requirements, for the owner's deployment
  planning**: `npm run orders:expire-abandoned` needs (a) `DATABASE_URL`
  pointed at the real production database, (b) `tsx` installed (now
  guaranteed by a production install since the dependency move above),
  (c) for a `"resend"` real-email configuration,
  `resolveEmailTransport()`'s own checks are irrelevant to this script —
  it never touches email — so no email-related env vars are required for
  this job specifically, (d) network access to the real Stripe API in
  production (never the fake/e2e-fake gateway there), and (e) an external
  scheduler invocation (cron, a platform's scheduled-function feature) at
  whatever interval the owner chooses — nothing in this codebase triggers
  it automatically, matching `emails:dispatch`/`images:cleanup-uploads`'s
  identical status.

**No unrelated domain refactoring was done.** Both fixes are additive to
the exact two functions the named race runs through
(`cancelDirectly`/`startPayment`); no other order/payment/inventory code
was touched. Full regression re-run after the actual changes: `tsc
--noEmit` clean, `eslint .` clean, `next build` (production) succeeded,
unit **451/451** (unchanged — no new unit tests this pass, consistent
with the prior pass's own reasoning for why these gateway behaviours are
tested through the integration suite's real `FakeStripeGateway`, not in
isolation), integration **187/187** (174 + the prior pass's 11 + this
pass's 2 new deterministic race tests), e2e **32/32** (unchanged).

**Recommended next concrete step**: unchanged in substance, restated with
corrected framing — the owner's domain purchase and Resend account/DNS
setup, and a separate future deployment-planning pass to activate the
three now-equally-"written, tested, not yet scheduled" CLI jobs and
choose/verify hosting, database, and backup infrastructure. None of this
is "remaining launch work this engagement still owes" in the sense of
unfinished local implementation — it is work that was never this
engagement's to perform (owner account/business decisions) or that
explicitly requires a real deployment target that does not exist yet.

### Sub-milestone: durable payment-creation coordination — correction of the 2026-10-03 "race fixed" claim (2026-10-06)

**Correction.** The 2026-10-03 sub-milestone above claimed the
`startPayment` / expiry-sweep creation race was closed by (a) a fresh local
`Payment` read inside the cancellation transaction and (b) a post-write
compensating `cancelPaymentIntent` in `startPayment`. **That claim was not
sufficient and is withdrawn.** A local read cannot see an in-flight provider
call, or an intent whose local write never commits; a post-write compensation
cannot run if the process stops after the provider call succeeds. The exact
failing sequence was: `startPayment` begins provider creation → sweep finds
no local `Payment` and a search miss → sweep cancels the order and releases
stock → provider creation succeeds → process stops before any local write.
That left a payable (or payable-then-paid) PaymentIntent against released
stock. Both mechanisms were timing checks; neither was durable coordination.
(The 2026-10-03 text is left as written for the audit trail; this section
supersedes its "fix" and "what remains" paragraphs.)

**Mechanism — persisted claim + one shared row lock. No migration.**

- `startPayment` now commits a **claim**: a `Payment` row with
  `providerPaymentId = NULL` (column already nullable; `@@unique([orderId])`
  gives one row per order) — written in a transaction that holds
  `SELECT … FOR UPDATE` on the `Order` row (`lockOrderRow`,
  `order-inventory.ts`) — **before any provider I/O**. Provider calls stay
  outside every DB transaction.
- Every stock-releasing cancellation (`applyOrderStatusTransitionTx`, used by
  the expiry sweep **and** the admin "Cancel" action) takes the **same lock**,
  re-reads current state under it, and **refuses (`ConflictError`) while an
  unresolved claim exists**. The sweep's direct-cancel path also refuses if
  any `Payment` row exists.
- PostgreSQL serializes the two: **cancellation first** → the claim
  transaction sees a non-`PENDING` order and aborts before the provider is
  called, so creation never starts; **claim first** → cancellation is refused
  and the reservation is preserved until the claim is authoritatively
  reconciled. A crash after provider success leaves the claim row, never
  "nothing" — so a missing local `Payment` row is meaningful for orders on this
  code, rather than something inferred from a search miss.
- No new release code: reconciliation reuses `finalizeFromPaymentIntent`
  (shared with webhook/return page) and `releaseReservationTx`'s per-line
  idempotency keys (`order:<id>:release:<variantId>`), so release stays
  exactly-once under repeated/concurrent recovery.

**Recovery policy for an unresolved claim — retention-aware.** Provider
idempotency is stable (`pi-create-<orderId>`), but Stripe documents that keys
are kept **at least 24 hours** and may then be pruned, after which the same
key makes a *new* request
([idempotent requests](https://docs.stripe.com/api/idempotent_requests),
[low-level errors](https://docs.stripe.com/error-low-level#idempotency)),
that a replay returns the **first response body** (so its `status` can be
stale — recovery always re-`retrieve`s), and that a concurrent request with
the same key yields `409 idempotency_key_in_use` (classified *ambiguous* by
`stripe.ts`'s `wrap()`: preserve and retry). Search is eventually consistent
and filters on a cached status ([search](https://docs.stripe.com/search)).
Claim age is measured from `Payment.createdAt` (written before the provider
call, so it can only over-estimate the key's age):

| Claim age | Action |
|---|---|
| < `CLAIM_INFLIGHT_WINDOW_MS` (10 min) | Leave strictly alone (`preserved_claim_in_flight`); original call may still be running. |
| < `IDEMPOTENT_RECOVERY_MAX_AGE_MS` (12 h — a conservative **application policy** well inside Stripe's documented "at least 24 h" retention; Stripe does **not** state that keys are pruned at 12 h) | Re-issue create with the **same key** (returns the original intent, or creates it if the first call never arrived — never a duplicate), then fresh `retrieve`, adopt into the claim (guarded `updateMany … WHERE providerPaymentId IS NULL`), reconcile via the shared path. |
| older | **Never re-issue** (could duplicate). Adopt only a search hit whose `metadata.orderId` matches, after a fresh `retrieve`. A miss is **not** proof of absence → `preserved_claim_needs_review`; stock stays reserved; `startPayment` for that order fails closed (`ConflictError`, no provider call). The CLI prints a warning. |

Any ambiguous provider failure (network, timeout, 409) → `preserved_ambiguous`:
nothing changed, retried next run.

**Operator runbook for `preserved_claim_needs_review`** (a claim > 12 h old, no
provider record found by search). Not auto-resolved on purpose. (1) In the Stripe
Dashboard search PaymentIntents by metadata `orderId` (value from the CLI
warning). (2) If one exists:
`UPDATE "Payment" SET "providerPaymentId" = '<pi_…>' WHERE "orderId" = '<id>' AND "providerPaymentId" IS NULL;`
— the next sweep reconciles it normally (paid → committed; payable → cancelled
at the provider then released). (3) If none exists *and* the Dashboard shows no
intent for that order's idempotency key / amount in the window, delete the
claim (`DELETE FROM "Payment" WHERE "orderId" = '<id>' AND "providerPaymentId" IS NULL;`);
the next sweep then cancels and releases normally. Do not delete a claim on a
search miss alone.

**Tests (deterministic; fake gateway + isolated test DB only).**
`tests/integration/order-expiry.integration.test.ts` is now **26 tests**
(was 17); `FakeStripeGateway` gained first-response-snapshot idempotent replay,
scripted lost-response / pre-create failure, key pruning, search-miss mode and
per-order intent counts. Covering the five required cases:
1. *Provider success, stop before local persistence* — real `startPayment`
   with a lost response leaves only the claim; young claim preserved
   untouched; once aged the sweep adopts the **same** intent (1 intent total),
   finalizes paid, 0 releases. Plus stale-replay (a since-succeeded intent is
   never cancelled), old-claim search-adopt (no re-issue), and old-claim
   search-miss + pruned key (no create call, no duplicate, `needs_review`,
   customer path fails closed, operator runbook step then reconciles).
2. *Expiry wins before creation* — `startPayment` refuses with zero provider
   calls; unit test asserts abort-before-provider under the lock.
3. *Creation wins before expiry* — claim committed ⇒ direct cancel refused
   (`ConflictError`); sweep preserves; later reconciles.
4. *Compensating cancellation fails/uncertain* — ambiguous cancel and
   ambiguous (409-style) re-create both preserve stock and succeed on retry.
5. *Concurrent/repeated recovery* — 3 concurrent + repeated sweeps ⇒ exactly
   1 `RELEASE`, the single intent is `canceled`; plus a 6-iteration real
   `startPayment` ∥ sweep race asserting, per iteration, "cancelled ⇒ released
   once and no payable intent; otherwise stock still reserved, ≤ 1 intent".
Unit: claim written before the provider call and provider call outside any
transaction (ordering asserted), abort-before-provider, stale-claim refusal,
and `stripe.ts` 409/`idempotency_key_in_use` ambiguity + cancel/search plumbing.
Four stale unit tests (they predated the new `FOR UPDATE` lock) were updated to
mock the lock row — not weakened.
A regression found and fixed on the way: the e2e checkout spec failed because
my first cut gated a *freshly created* intent's status; fresh creates now return
the client secret exactly as before the claim existed (replays/recoveries still
re-retrieve).

**Verification (2026-10-06):** `tsc --noEmit` clean; `eslint src tests scripts`
clean; unit **457/457** (451 + 6); integration **200/200** (includes the 26-test
expiry file); `next build` succeeded; e2e **32/32** (after
clearing OneDrive-locked `.next`/`.next-e2e`). No real Stripe calls, no email,
no dev-DB writes, no commits.

**Migration: none required.** The claim reuses the existing nullable
`Payment.providerPaymentId`; nothing is pending for the dev database.

**Remaining limitations (stated plainly).**
- Stuck-stock fail-safe: a claim > 12 h old with no findable provider record
  holds its reservation until an operator runs the runbook above.
- ~~Admin cancellation of a resolved, still-payable intent~~ and ~~pre-claim
  orders~~ were the two disclosed gaps here — both closed in the next
  sub-milestone (provider-aware admin cancel; legacy-order handling).
- The recovery policy's constants rest on Stripe's *documented* retention
  ("at least 24 h") and have **not** been exercised against live Stripe; the
  real-Stripe behaviour of 409 handling and replay bodies is unverified here.
- `order.expired` audit rows are not exactly-once under concurrent sweeps
  (inventory release is). No scheduler is activated; domain/DNS, real email
  activation, and production scheduling remain deferred activation
  dependencies, not resolved launch requirements.

### Sub-milestone: provider-aware admin cancellation + legacy-order handling (2026-10-06, same milestone)

Closes the two cancellation gaps disclosed above. No migration; nothing
pending for the dev database.

**The safety invariant, precisely.** *Stock is never released for an order
while any payment against it could still be payable or succeed.* Enforced
structurally in `applyOrderStatusTransitionTx` (every caller: expiry sweep,
admin cancel, payment-failure finalization), under the `Order` row lock:
a release is refused (`ConflictError`) while the order has any `Payment` row
that is not locally terminal (`FAILED`/`CANCELLED`) — i.e. an unresolved
creation claim (`providerPaymentId` null) **or** a linked PaymentIntent the
provider has not yet confirmed cancelled. The only code that moves a payment
to a terminal status before releasing is `finalizeFailureTx`, which runs only
after the provider reported `canceled`. And the converse: `startPayment`'s
claim transaction takes the same lock and aborts before any provider call if
the order is no longer `PENDING`/`UNPAID`. A `late_success`/refund outcome is
**not** treated as equivalent to prevention: it means a customer was charged
against released stock, and no path here relies on it.

**1. Admin cancel of a linked, still-payable PaymentIntent**
(`src/server/orders/order-cancellation.ts`; `changeOrderStatus` now routes
`PENDING → CANCELLED` through it):
- Linked intent ⇒ fresh `retrieve`, then the **same** `reconcileLinkedPayment`
  as the sweep (cancel at the provider with a stable key, then the shared
  `finalizeFromPaymentIntent` → release). Provider I/O is outside every
  transaction; release happens only after authoritative confirmation.
- Admin-visible results (each a distinct, explicit message; the order is never
  left half-cancelled; a `order.cancel.preserved` audit row records the
  reason): **cancelled** (provider confirmed; released once); **payment had
  succeeded** (reconciled PAID/CONFIRMED, *not* cancelled — refund is the
  admin's separate, explicit step); **processing** (untouched); **provider
  uncertain** — timeout/network/409, including a cancel that the provider
  applied but whose response was lost (untouched; the retry reads
  `canceled` and releases once).
- Unresolved claim ⇒ refused by the shared lock/guard. No row + search hit ⇒
  fresh retrieve, backfill, reconcile as above.

**2. Pre-change (legacy) orders without durable claims — fail closed.** A
pre-claim `startPayment` could create a PaymentIntent and crash before any
local write, and Stripe Search is eventually consistent, so for such orders
neither "no `Payment` row" nor "search miss" proves no payment exists. The
database this project runs against in development **does** contain pre-claim
orders, so a missing configuration value must not assert otherwise.
`PAYMENT_CLAIMS_ACTIVE_SINCE` (optional ISO-8601; `.env.example`) is the
rollout boundary. `claimEra(createdAt, boundary)` classifies every order:
`post_claim` (created at/after it), `legacy` (before it), or **`unknown`
(boundary unset)**. For an order with **no local `Payment` row and no provider
search hit**, only `post_claim` may be released; `legacy` and `unknown` are
preserved:
- sweep: `preserved_legacy_needs_review` / `preserved_claims_cutoff_unconfigured`
  (stock stays reserved; the CLI prints which orders, says configuration is
  required for the unconfigured case, and exits non-zero so a scheduler
  notices);
- admin cancel: refused with an explicit "NOT cancelled, stock stays
  reserved, manual reconciliation required" message and an
  `order.cancel.preserved` audit row.
Where authoritative evidence exists, nothing changes in any era: a linked
`Payment` is reconciled/cancelled through the provider-aware path, and a
search **hit** is re-retrieved (never trusting its cached status), adopted and
reconciled.

**No operator override.** An earlier cut of this milestone offered an
"I checked Stripe: no payment exists — cancel anyway" admin action. It is
**removed** (UI, server parameter, audit action): an operator checkbox, like a
search miss, is not authoritative proof that no payment can still succeed, and
an in-app control must not bypass the payment/claim guards. The structural
guard in `applyOrderStatusTransitionTx` still refuses any release while an
unresolved claim or an unconfirmed linked payment exists; the era check lives
in the two cancellation entry points (sweep, admin cancel) that decide on "no
row" evidence. The only in-app resolution path for an ambiguous legacy order
is **evidence**: link the real PaymentIntent (below).

**Establishing the rollout boundary** (never set automatically — not to "today",
not at config time; dev configuration and data were not touched):
1. Deploy the claim-writing code to **every** process that can create
   payments against the database: all web instances, workers, cron/CLI hosts,
   preview/staging deployments sharing the DB. An *old* instance that is still
   serving can create a PaymentIntent with no claim.
2. Drain and **stop** every old instance (removal from a load balancer is not
   enough — in-flight requests and long-lived connections continue). Record
   the instant the last old instance was confirmed stopped, `T_stop`.
3. Allow in-flight requests to finish: provider call budget is the Stripe SDK
   timeout (20 s) × up to 3 attempts, plus DB transaction limits (20 s), so
   allow a margin of at least 10 minutes (the same value as
   `CLAIM_INFLIGHT_WINDOW_MS`).
4. Set `PAYMENT_CLAIMS_ACTIVE_SINCE = T_stop + margin` (UTC ISO-8601) and
   restart. Setting it **later** than the true boundary is safe (more orders
   are treated as legacy and flagged); setting it **earlier** is unsafe (an
   old instance's attempt could be treated as provably absent). When in doubt,
   pick later.
5. Orders created before the boundary but first paid *after* it are fine: the
   new code writes a claim, so they carry evidence.

**Legacy / unconfigured-order runbook (evidence only):**
1. For each order the CLI or admin flags, search the Stripe Dashboard for
   PaymentIntents with metadata `orderId = <id>` (also by amount/date, since
   the pre-claim attempt may predate reliable metadata search).
2. **Found**: insert a `Payment` row for the order with that
   `providerPaymentId` (provider `stripe`, status `PENDING`, the order's
   `totalCents`/`currency`). The next sweep reconciles it through the normal
   path (paid ⇒ committed; payable ⇒ cancelled at the provider, then
   released).
3. **Not found / cannot be established**: leave it reserved. There is
   deliberately **no in-app action** that releases it, and this document does
   not claim every case is automatically recoverable. Releasing such an order
   needs a deliberate, out-of-band engineering/operator decision (for example,
   a reviewed manual database reconciliation after an authoritative Stripe
   investigation, with the owner accepting the residual risk) and is
   **unresolved by this milestone**.
A legacy order whose search later catches up is resolved automatically on the
next sweep with no operator action.

**Tests** (deterministic; fake gateway + isolated test DB):
`tests/integration/admin-cancel.integration.test.ts` — **17 tests**, plus 4
unit tests for the structural guard / `claimEra`. `FakeStripeGateway` gained scripted cancel-lost-response and an
`onNextCancel` hook (lands a payment between the caller's read and the
provider seeing the cancel). Covered:
- *Admin cancel racing a successful payment* — hook succeeds the intent just
  before the cancel: not cancelled, order PAID/CONFIRMED, 1 `SALE`, 0
  `RELEASE`, no `late_success`; and the already-succeeded and processing
  variants (provider never asked to cancel).
- *Cancellation failure/timeout* — ambiguous failure ⇒ nothing released,
  intent still payable, retry releases once; lost-response variant (provider
  canceled, caller unaware) ⇒ stock stays reserved until the next
  authoritative read, then exactly one release; repeated admin/sweep runs add
  none; admin ∥ admin ∥ sweep concurrency converges to one release.
- *Duplicate/delayed webhooks after a confirmed cancel* — `canceled` event,
  its duplicate, and a stale `succeeded` event change nothing (1 release, 0
  sales, order CANCELLED/FAILED).
- *Legacy + eventually-consistent miss* — a real hidden intent with search
  missing: sweep preserves and flags on repeated runs, admin cancel refuses,
  the intent is untouched and never cancelled; when search catches up the
  next sweep reconciles it (cancelled-and-released, or — for a hidden
  succeeded intent — PAID with 0 releases); a post-claim order with a miss
  still cancels automatically; after an admin cancel, `startPayment` makes
  zero provider calls.
- *Unconfigured boundary fails closed* — no-row order + search miss is
  preserved by the sweep (repeated runs, default-shaped policy with no
  boundary) and refused by admin cancel with the configuration message; stock
  stays reserved, 0 releases. Authoritative evidence still reconciles with the
  boundary unset: a linked payment (admin cancel; sweep finalizing a
  succeeded one as paid) and a search hit.
- *Attempted overrides refused* — the removed attestation option, passed
  anyway to both `cancelPendingOrder` and `changeOrderStatus`, cannot release
  a legacy order with a hidden payment (2 `order.cancel.preserved` audits,
  0 releases); an unresolved claim + search miss + the same option is refused
  by the shared guard ("payment attempt in progress"), provider never asked
  to cancel.
- Structural guard: a direct release through the transition is refused while
  a payment is live (unit + integration). Mutation check: disabling the guard
  or the era check (`unknown` → `post_claim`) makes exactly the
  corresponding tests fail.

**Verification (2026-10-06):** `tsc --noEmit` clean; `eslint src tests
scripts` clean; unit **461/461**; integration **217/217**; `next build`
succeeded; e2e **32/32** (after clearing OneDrive-locked `.next`/`.next-e2e`).
No real Stripe calls, emails, dev-DB changes, migrations, commits or pushes;
port 3000 untouched.

**Remaining limitations / activation tasks.**
- Real-Stripe behaviour (409 handling, replayed bodies, cancel refusal
  shapes, search lag) is documented-API-shaped but unverified against a live
  Stripe account — the owner's Test-Mode check.
- A claim older than 12 h with no findable provider record, and legacy /
  unconfigured-era orders with no payment evidence, hold stock until an
  operator investigates (runbooks above). Failing safe at the cost of stuck
  stock is deliberate, and **not every such case is automatically
  recoverable** — "conclusively no payment exists" has no in-app resolution.
- Provider-uncertain admin cancels need a manual retry (no automatic retry
  queue; the sweep also retries on its schedule once activated).
- `order.expired` audit rows are not exactly-once under concurrent sweeps
  (inventory release is).
- **Deferred activation dependencies** (owner/deployment side, not resolved
  launch requirements): domain purchase + DNS; real email activation (Resend
  account/domain verification); production scheduling of
  `orders:expire-abandoned` (plus `emails:dispatch`,
  `images:cleanup-uploads`); **establishing and setting
  `PAYMENT_CLAIMS_ACTIVE_SINCE`** per the rollout-boundary procedure above
  (until then the sweep and admin cancel preserve every no-evidence order).

**Milestone status (2026-10-06): LOCAL IMPLEMENTATION CLOSED.** Evidence: the
persisted-claim + shared-lock coordination, retention-aware recovery,
provider-aware admin cancellation, and fail-closed legacy/unconfigured-era
handling are implemented and covered by deterministic tests (unit 461,
integration 217, e2e 32; tsc/eslint/build clean; mutation checks show the
key tests fail when their guard is disabled). **Still pending, explicitly not
claimed:** (1) validation of the *new* claim/cancellation/recovery behaviour against real Stripe
in Test Mode (idempotency retention/409/replay, cancel refusal shapes, search lag; the earlier checkout and refund
flows already had real Test Mode evidence); (2) production
activation — scheduling, establishing/setting `PAYMENT_CLAIMS_ACTIVE_SINCE`
per the procedure above, domain/DNS and real email; (3) operator
investigation of any flagged legacy/needs-review orders, some of which may
have no automatic resolution.

### Sub-milestone: customer self-registration + verification resend (2026-10-06)

**Why.** The read-only journey assessment found guest checkout works but a
customer had no way to create an account, receive a first verification email,
or see order history (`requestEmailVerification` had no caller; no `/register`).
This milestone adds exactly that — nothing else.

**What a customer can now do**
- `/register` (first name, last name, email, password) → `POST /api/auth/register`.
  Uses the existing email normalization, password policy (`hashPassword`),
  Argon2id hashing, `guardMutation` (same-origin + double-submit CSRF) and the
  rate limiter (new `registration` policy: 10/hour, applied per email **and**
  per IP).
- "Create account" links on the login page and in the storefront header
  (logged out); "Account" + "My orders" when signed in. Login now lands
  customers on `/account` (staff/admin still on `/admin`) when no explicit
  `next` is given.
- Registration immediately calls the existing `requestEmailVerification`; the
  email links to the existing scanner-safe `/verify-email` page (explicit
  button click consumes the token).
- `/account` shows name, email and verification status and, if unverified, a
  rate-limited **Resend verification email** control → authenticated
  `POST /api/auth/verify-email/resend` (no body; address comes from the session).

**Account-status / login policy chosen (smallest compatible).** Login requires
`status = ACTIVE` and never looked at `emailVerifiedAt`, so a new customer is
created **`CUSTOMER` / `ACTIVE` / unverified** and can sign in at once. Nothing
in the app is gated on verification, so an unverified customer **can**: sign
in, browse, check out and pay, view their own orders, and request a new
verification link. Verification is **advisory today**; gating anything on it
is a separate, explicit future decision. Staff/manager/admin rules were not
touched — access is by `role`, and registration can only ever produce `CUSTOMER`.

**Security properties**
- Role, status and verification state are constants in `registerCustomer`
  (`src/server/auth/registration.ts`); the function has no parameter for them
  and the route's Zod schema strips `role`, `status`, `emailVerifiedAt`,
  `permissions` and any other unknown key.
- No account enumeration: new and already-registered emails get the same
  response and the same on-screen text. The password is hashed before the
  insert on both paths; the `User.email` **unique constraint** decides
  duplicates (also what makes concurrent registrations safe — exactly one
  account, one email, no errors). A duplicate never writes to the existing
  account (not password, role, name, status — verified against an ADMIN
  account) and sends no email. Only password weakness (422) and rate limiting
  (429) are distinguishable.
- Email failure is recoverable: the account commits **before** any email is
  attempted; a transport failure is caught, audited, and the customer can sign
  in and use Resend, which (being authenticated) reports a failed send honestly
  (502, audited) instead of pretending. UI copy only says a link was
  *requested*, never that it arrived.
- Resend is rate-limited by the existing `verificationRequest` policy
  (5/hour per email and per IP); a newer link invalidates the older one.
- **Guest orders are never attached by email**, before or after verification
  (explicitly deferred). Order ownership now comes from *who is placing the
  order*: `placeOrder` uses `identity.userId`, not a stale `cart.userId`, so a
  cart first used while signed in and continued as a guest after sign-out
  yields a guest order, not one in the earlier customer's history. (Small
  correction in `checkout-service.ts`; guest checkout unchanged.)

**Schema / migration:** none (`User`, `VerificationToken` already fit). Nothing
pending for the dev database.

**Evidence (2026-10-06; isolated test DB, fake mailer, local-preview e2e mail,
fake payments)**
- Integration `customer-registration.integration.test.ts` — 13 tests:
  registration → fake delivery → explicit verification (single use) → login as
  unverified/verified customer; invalid / expired / wrong-purpose tokens; tampered
  role/status/verification/permissions (schema strips; also forwarded raw to the
  service — still CUSTOMER/ACTIVE/unverified); weak and personal-info passwords
  (no account, no email); duplicate incl. case/whitespace and a privileged
  account (nothing overwritten, nothing sent); 6-way concurrent registration;
  failing transport → usable account → honest resend failure → recovery; resend
  requires sign-in / no-op when verified / supersedes older link; resend limit
  (6th refused before the transport) and per-IP / per-email registration limits;
  order ownership (authenticated order is the customer's and only theirs; a
  historical guest order with the same email stays guest and un-claimed;
  stale-cart-as-guest; guest checkout still works). Mutation check: forwarding
  `role` from input, or reverting to `cart.userId`, makes exactly the matching
  tests fail.
- Unit `registration.test.ts` (schema, rate-limit constant, landing path).
- E2E `registration.spec.ts` — 5 tests through the real browser: entry points →
  register → generic confirmation (no delivery claim) → read the local-preview
  email → GET does nothing, explicit click verifies → sign in → `/account`
  → customer gets "Access denied" at `/admin`; duplicate (identical page, no
  email, account unchanged); tampered request to the real endpoint; weak
  password; unverified customer resends (new preview email), checks out, and the
  order appears in their history with `userId` = them.
- Existing `admin-orders.spec.ts` "CUSTOMER is denied admin access" now logs in
  with an explicit `next=/account` (customers no longer default to `/admin`).
- `tsc`, `eslint src tests scripts` clean; unit **470/470**; integration
  **230/230**; `next build` succeeded; e2e **37/37** on the final full run (an
  intermediate full run showed one `admin-orders` status-transition test flaky
  once; two later runs — including a full one — were clean, cause not isolated).
- Not claimed: no real email was sent (local-preview/fake transports only), no
  real Stripe call, no manual acceptance by the owner.

**Simple manual review (the owner runs this; it creates a real user row in
whatever database the dev server uses — use a throwaway address):**
1. Start the dev server; open `/register`, create an account with a throwaway
   email and a strong password. Expect the "if that email can be used…" message.
2. Open the newest `*-email-verification.txt` in `.local/email-previews/` (the
   default non-production transport writes there; nothing is sent) and open its
   link. Click **Verify email**; expect the success message.
3. Sign in at `/login` (no `next`): you should land on `/account` showing
   "Verified". Try `/admin`: expect "Access denied".
4. Register a second throwaway account but do **not** verify; on `/account` use
   **Resend verification email** and confirm a new preview file appears.
5. Register the first email again: same on-screen message, no new preview file;
   the original password still works.
6. Signed out, add a product and check out as a guest; signed in, check out and
   confirm the order is listed under **My orders**.

**Manual review (owner-completed, against their own dev server; recorded as
reported).** Registered a throwaway account (zara-review-1006@example.com);
signed in and opened Account; Account → View my orders showed the empty-orders
message with a "Start shopping" link; opened the **local verification-email
preview file** (`.local/email-previews/`), followed its link, and explicitly
clicked **Verify email** — the page displayed "Your email address has been
verified." **What this does and does not establish:** it confirms registration,
sign-in, the account page, the empty order history, and the
preview → link → explicit-confirm verification path in a real browser. It does
**not** establish real email delivery (the local-preview transport writes a
file; nothing was sent) and it did **not** include a manually placed customer
order (order ownership is covered by automated tests only). The remaining
manual-review steps above (resend, duplicate registration, guest vs signed-in
checkout) are not recorded as done.

**Observed dev-overlay "1 Issue" on the success page — diagnosed, not a
product defect.** The Next.js dev overlay's issue was a React *hydration
mismatch* on `<body>` (diagnostics read, read-only, from the dev server's own
error/log endpoints). The diff shows the browser had added
`data-smart-converter-loaded="true"` to `<body>` before React hydrated; the
dev log also shows a second extension, "cently", failing to patch
`window.location`. Both are **browser extensions** modifying the page — the
attribute appears nowhere in this repository's source, and the server-rendered
HTML did not contain it. It did not affect the flow (verification succeeded), is
dev-only, and no code change was made. If the noise becomes a nuisance, test in
a private window with extensions disabled; `suppressHydrationWarning` on the
root `<body>` is the usual mitigation but was deliberately not applied since it
masks real mismatches.

**Milestone status (2026-10-06): customer self-registration — bounded local
milestone ACCEPTED** on the combination of automated evidence above and this
owner manual review. Still **not** claimed: real email delivery (Resend + a
verified domain are activation tasks), a manually placed customer order,
guest-order claiming (deferred), or gating anything on verification.

**Limitations / deferred (explicit).**
- **Guest-order claiming is deferred**: historical guest orders are never
  attached to an account by email, even after verification.
- Verification is advisory (gates nothing). Consequence to be aware of: someone
  can register an account for an email they don't own (unverified); the real
  owner takes it over via the existing password-reset flow, and no order data is
  attached by email, so there is nothing to leak — but gating on verification
  later should be weighed against this.
- The rate limiter is the existing in-process one: correct for a single
  instance; multi-instance production needs the shared-store limiter already
  noted in `docs/security.md`.
- The account page is minimal (no profile edit / change-password UI yet).
- Real email delivery (Resend + a verified domain) remains an activation task;
  until then only local-preview/fake transports have been exercised.
- Pre-existing, observed: a CUSTOMER opening `/admin` gets the correct "Access
  denied" page, but the server logs a `requires STAFF` error from the admin page
  component. Not changed (admin rules untouched).

---

## Phase 11 — Tax & shipping configuration UI 🟡 (smallest milestone implemented 2026-10-06; page-display + CUSTOMER-denied reviews accepted; launch coverage = all of Canada; prices and tax rates unconfirmed)

**Scope delivered (and what was deliberately not).** A minimal ADMIN UI to view and
maintain exactly the fields the checkout already supports — no new tables, **no
schema change, no migration** (the existing `TaxRegion`/`TaxRate`/`ShippingZone`/
`ShippingZoneRegion`/`ShippingMethod` models were sufficient), and no change to the
tax or shipping calculation rules (`ConfiguredRateTaxCalculator`,
`FlatRateShippingProvider` are reused as-is):
- `/admin/settings/tax` — tax regions (province or one country-wide fallback) and
  their rates: name, **rate in percent** (stored as the exact fraction, `5` →
  `0.05`, up to 4 decimals), product tax category, priority, compound, active,
  effective-from/to (UTC dates; "to" is end-of-day).
- `/admin/settings/shipping` — zones, the provinces each covers, and flat-rate
  methods: **price in CAD dollars** (→ integer cents), optional free-shipping
  threshold (CAD), delivery-day range, sort order, description, active.
- Both pages show a **coverage table** — what checkout would do right now for each
  of the 13 provinces/territories, computed by the real calculators.
- Dashboard links (ADMIN only). Service: `src/server/settings/tax-shipping-service.ts`;
  schemas: `src/lib/validation/tax-shipping.ts`; actions: `src/app/admin/settings/`.

**Rules the implementation follows**
- **Authorization:** every service function (reads included) requires the existing
  `settings.write` permission = ADMIN only; MANAGER/STAFF/CUSTOMER/anonymous are
  refused server-side and the pages render "Access denied". (No narrower existing
  permission exists; a read-only role for managers would be a separate decision.)
- **CSRF:** Server Actions, protected by Next.js's built-in Origin/Host check — the
  same defence every other admin form in this app uses.
- **Validation:** blank/garbage/negative/over-100% rates, >4 decimals, non-money or
  negative or absurd prices, min>max days, "to" before "from", impossible calendar
  dates (e.g. 2026-02-30, which JavaScript would silently roll over — caught by a
  test) and unknown provinces are rejected with a clear message. **There is no
  default rate and no default price**: a blank field is an error, so an empty form
  can never create 0% tax or free shipping; `0.00` is accepted only when typed and
  the form says it means free shipping. The province selects start on "Choose…".
- **Audit:** every create/update/coverage change writes `config.*` audit rows with
  the actor and before/after values.
- **No deletion:** nothing deletes a region, rate, zone or method — switch it
  `active = false` instead (the only hard delete is a zone↔province link row, which
  has no history and is audited). Identity fields (a region's province, a rate's
  name/category, a method's zone/name) are not editable; add a new row and
  deactivate the old one.
- **Historical orders are unaffected by construction:** an order stores its own
  snapshot (`shippingCents`, `taxCents`, `totalCents`, `OrderItem.lineTaxCents`) and
  has no foreign key to any row edited here. Tested.
- **Missing configuration is explicit, per the existing rules, not papered over:**
  a province with no active region/rate **charges $0.00 tax** (existing rule — the
  coverage table and a warning say so), and a province with no active method
  **cannot check out** (existing rule — nothing is substituted). Nothing here
  introduces free shipping or zero tax.

**Not done (out of scope, unchanged):** carrier integration, labels, discounts,
third-party tax providers, and the roadmap's "weight band" shipping rules — the
current models and checkout have no weight-band fields (`weightGrams` is carried on
the interface but unused by the flat-rate provider), so adding them would need a
schema change and calculator change; not attempted.

**Evidence (2026-10-06; isolated test DB — own jurisdictions, never the fixtures):**
- Integration `tax-shipping-admin.integration.test.ts`, 35 tests: authorization
  (anonymous/CUSTOMER/STAFF/MANAGER refused on all 13 service functions with no row
  or audit written; ADMIN allowed); validation tables for rates, regions, methods,
  zones; duplicate = conflict never overwrite; **configuration → new quotes**
  (5% → tax 50¢ on $10.00; edit to 7.5% and price $9.99 → $14.00 changes the *next*
  quote and order only); **historical order's tax/shipping/total/line tax unchanged
  after edits**; free-threshold applied only when configured and met, and clearing it
  removes it; deactivating the method → shipping unavailable and `placeOrder`
  refuses; deactivating a rate / region / expiring the window → the existing $0 tax
  rule appears as "not configured" in coverage; zone deactivation and coverage
  removal end availability; audit rows with actor and before/after.
- Unit `tax-shipping-validation.test.ts` (19). E2E `tax-shipping-admin.spec.ts`
  (3): MANAGER denied both pages; ADMIN creates a region, is refused a bad rate,
  adds/edits/deactivates a rate (stored `0.05`) and sees coverage change; ADMIN
  creates a zone, coverage and a priced method, is refused bad prices, deactivates
  it.
- `tsc`, `eslint src tests scripts` clean; unit **489**, integration **265**, e2e
  **40** all passing; the e2e run builds and serves the production bundle
  (`.next-e2e`), which is the build check. The `.next` directory used by the
  owner's running dev server was not touched.
- A shared-admin-form behaviour noticed while writing the e2e test (not changed):
  `ActionForm` clears its uncontrolled fields after any submission, including a
  rejected one, so an admin must retype after an error.

**Dev database / activation.** No migration and no change to the dev database's
existing business configuration was made (it still holds only the seed's example
Ontario/HST row and "Canada / Standard" method). **Owner inputs still required
before launch:** the real shipping geography, the actual tax rates for each place
you will ship to (and whether your situation requires charging tax at all — not
determined by this software), and shipping prices. Also an owner decision, not
changed here: under the existing rule a province with no tax configuration charges
$0 tax rather than blocking checkout; the coverage table makes that visible, but
whether to *block* instead is yours. The seed's example 13% / $12 values are
sample data — decide whether production should run the seed at all.

**Manual review (owner-completed; recorded as reported).**
1. *Access control (one specific observation):* before signing in as an ADMIN, the
   owner opened the tax settings page while signed in as the **test CUSTOMER** and
   saw "Access denied". Only that CUSTOMER → tax-settings case was observed by hand;
   the shipping page, and MANAGER/STAFF accounts, were not manually checked (they
   are covered by the automated authorization and browser tests).
2. *Page display (read-only):* signed in as an ADMIN, opened the tax settings page
   and saw Ontario at 13%, then the shipping settings page and saw the $12 shipping
   price. **No values were edited or saved.**

**Accepted: the page-display and the CUSTOMER access-denied observations only.**
Create/edit behaviour has *not* been manually exercised; it remains supported by the
automated tests above (integration, unit and browser), not by owner acceptance. The
remaining steps in the checklist below (e.g. MANAGER/STAFF denial, checkout matching
the pages) are not recorded as done.

**Owner-confirmed launch input — shipping coverage.** The owner confirmed that
launch shipping coverage is **all of Canada, including all 13 provinces and
territories**. This is a statement of intended geography only: it is not a
configured or approved shipping *price* (see below), and the coverage table on the
shipping page remains the source of truth for what the system is actually configured
to offer at any moment.

**Still unconfirmed and owner-owned:** the **production shipping prices** and the
**tax obligations and actual tax rates** for the places you will ship to. The
Ontario 13% rate and the $12 "Canada / Standard" shipping price that the pages
display are the seed's **sample values**, not approved nationwide settings; nothing
in this software determines what tax you must charge, and no production rate or
price has been entered or approved.

**Simple manual review (on your dev server; changes real dev configuration — use
obviously-fake names/values and switch them off afterwards, or skip the save steps):**
1. Sign in as an ADMIN → dashboard → **Tax rates**. Read the coverage table: Ontario
   shows the seeded rate; other provinces say "NOT CONFIGURED — $0.00 tax charged".
2. (Optional) Add a region for a province you do not ship to, try saving a rate with
   a nonsense value like `abc` (expect a clear error), then a valid one, and watch the
   table change; deactivate it again.
3. **Shipping methods**: confirm the coverage table lists "Standard $12.00" for
   provinces, try a price like `ten` (error), and read the labels (CAD dollars,
   `0.00` = free).
4. Sign in as a MANAGER/STAFF user (if you have one): both pages say "Access denied".
5. As a shopper, check out in a province you left unchanged: tax and shipping match the
   pages. Existing orders keep their original totals.

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

## Phase 13 — Hardening & production deployment 🟡 (production runtime milestone built and locally verified 2026-10-08; staging/CI/monitoring not started)

### Sub-milestone: reproducible production runtime (2026-10-08)

**Built.** `Dockerfile` (multi-stage; Node 24 bookworm-slim; `next start`; non-root uid 1001;
`/api/health` HEALTHCHECK; default target `runner` = web + the three jobs; `migrate` target =
`prisma migrate deploy` only), `.dockerignore` (secrets/`.env*`, `.local/` email previews, local
storage, dumps/backups, `.git`, `tests/`, `docs/`, build output), and `docs/deployment.md` (build
args, names-only environment checklist, separate migration step, web and job commands, an
isolated smoke-test recipe, limitations). `output: "standalone"` was deliberately **not**
adopted: its traced bundle omits what the jobs need (`tsx`, `src/`), so the older plan to
re-add it in Phase 13 is superseded. No hosting provider, scheduler, CI or public endpoint was
added; the migration is never run on startup.

**Verified (actually run, 2026-10-08, against the built image).** Isolated throwaway Postgres on
its own Docker network, synthetic keys/URLs only, web published on loopback `:3199` (never 3000), no
real Stripe/Resend/S3 contact, dev database and storage untouched:
- Both targets build from a clean context; the Next build needs no database. Runner image
  contains no `.env`, `.local`, `.git`, `tests/` or `docs/`; runs as uid 1001.
- Explicit migrate step: 0 → 35 tables, all migrations applied. After starting the web app
  (twice) the table count was unchanged and `User` had 0 rows — startup neither migrates nor seeds.
- Web app in `NODE_ENV=production`: `/api/health` ok (container reports `healthy`); `/`, `/login`,
  `/register`, `/cart` → 200 (storefront reads the DB), unknown product → 404; production
  security headers present (HSTS, nonce CSP, nosniff, frame-deny).
- All three job entry points run in the image with production config and an empty database:
  `emails:dispatch` (claimed 0), `images:cleanup-uploads` (S3 configured, found 0),
  `orders:expire-abandoned` (scanned 0); `@node-rs/argon2`, `sharp` and the AWS S3 SDK load.
- Production safeguards were **not** relaxed to make this pass — each refusal was re-confirmed
  inside the image: `EMAIL_TRANSPORT` = `noop`, `local-preview` or unset is refused; the real
  transport is refused with a localhost app URL; `PAYMENT_GATEWAY=e2e-fake` is refused outside
  the e2e harness. (The smoke test therefore uses the real email transport class with a fake key
  and an empty outbox, so nothing is ever built or sent.)
- Focused checks after the one code change: `tsc` and `eslint` clean; unit tests for
  notifications, the Resend mailers and the new guard pass (39). The full application suite
  was **not** rerun: the change is a behaviour-preserving constructor refactor, not a project gate.

**A real defect found by this verification and fixed.** `emails:dispatch` could not start in
production: `ResendOrderMailer` used a TypeScript constructor parameter property, which plain
`node` (type-stripping only) rejects with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, while every
Vitest suite (which transpiles) stayed green. It reproduced on the host too. Fixed with
explicit fields in `src/server/notifications/order-mailer.ts`; new regression test
`tests/unit/job-scripts-loadable.test.ts` loads, under real `node`, every module the two
plain-`node` job scripts import (list read from the scripts), and fails if the syntax returns
(confirmed by reintroducing it).

**Runtime limitations (stated plainly).**
- Never run against a real database with data, real S3/MinIO, real Stripe or real Resend; the
  job paths were exercised only on empty data, so retry/claim logic inside them is covered by
  the existing automated suites, not by this smoke test.
- Three public values (`NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`,
  `S3_PUBLIC_BASE_URL`) are baked in at build time: one image per environment.
- Image is large (~1.5 GB; full production `node_modules` incl. `sharp`, `exceljs`, AWS SDK, `tsx`);
  no layer/size optimisation attempted. Build was verified on Docker Desktop (linux/amd64 host);
  other architectures untested.
- The in-process rate limiter and Next.js cache are per-instance: run a **single** web instance
  until the shared-store limiter noted in `docs/security.md` exists.
- The two plain-`node` jobs print a harmless `MODULE_TYPELESS_PACKAGE_JSON` warning.
- No scheduler exists; the three jobs run only when something invokes them.

**Still open for Phase 13 (not started):** CI pipeline, staging deployment with real providers,
structured logging / error tracking / uptime monitoring, backup & restore runbook,
expand/contract migration policy, load test, rollback exercise, security-header scan.

**Smallest next launch-critical milestone: first-ADMIN bootstrap — implemented (see next
sub-milestone).**

### Sub-milestone: first-ADMIN bootstrap (2026-10-08)

**Built.** Operator-only CLI `scripts/bootstrap-admin.ts` (`npm run admin:bootstrap`; in the image:
`docker run -it --rm --env-file … <img> node_modules/.bin/tsx scripts/bootstrap-admin.ts --email …`)
over `src/server/auth/bootstrap-admin.ts`. It creates exactly one `ACTIVE`, **not**-email-verified ADMIN
and one `auth.admin.bootstrapped` audit row (no actor, no secret). No business data, no email, no HTTP
endpoint, not run by web startup, migrate, or seed. Reuses the existing email schema, `hashPassword`
(Argon2id + password policy), `createUser`, `recordAudit`. (`adminCreateUser` was not reused: it creates
`INVITED` users, who cannot sign in.) Password: hidden TTY prompt, twice, up to 3 attempts; no flag, env
var or pipe; a non-interactive stdin and any `--password` are refused. Refuses (exit 2, nothing changed)
if **any** ADMIN exists or the email belongs to **any** account — never promotes or overwrites. Concurrency:
check-and-insert in one transaction behind a Postgres advisory lock (+ the unique email index as backstop).
Rerun / lost-output handling is in `docs/deployment.md` § "First administrator": re-running is a harmless refusal, verify read-only, then normal sign-in or password reset; if those are unavailable, operator-assisted recovery is an **unresolved gap** (no manual row-deletion procedure is documented).

**Verified.**
- Integration `bootstrap-admin.integration.test.ts` (8, isolated test DB, real Argon2id and the real auth
  service for sign-in, fake mailer): creation + normalization + sign-in (wrong password rejected) + exactly one
  new user + **every business table count unchanged** + no email; audit row without any secret; ADMIN-exists
  refusal leaves the admin row byte-identical; existing CUSTOMER/STAFF email refused with the row unchanged and
  no ADMIN appearing; invalid email / weak / personal-info password create nothing; 8 simultaneous different-
  email attempts and 6 same-email attempts → exactly one ADMIN; a **deterministic** race test (one attempt held
  open between its checks and its insert via a test-only hook). Mutation check: removing the advisory lock makes
  the deterministic and the 8-way tests fail; the lock is restored.
- **Actual CLI in the rebuilt production image**, against a throwaway Postgres (synthetic data, loopback only,
  no providers): non-TTY stdin refused (exit 2); `--password` refused; interactive run through a real
  pseudo-terminal — password not echoed (0 occurrences in captured output), weak password rejected with
  reasons then a good one accepted; DB shows one ADMIN, `ACTIVE`, unverified, Argon2id hash, one audit row;
  the real `authenticateWithCredentials` inside the image accepts the right password and rejects a wrong one;
  rerun refused with the `User` table byte-identical (md5); an existing CUSTOMER email refused with that row
  byte-identical; three simultaneous CLI processes with different emails → one created, two `admin_exists`;
  **0 rows** in Product, ProductVariant, Brand, Category, InventoryItem, StockMovement, TaxRegion, TaxRate,
  ShippingZone, ShippingZoneRegion, ShippingMethod, Order, Cart, Discount and ImportJob. After the final image
  rebuild the entry point was re-checked (non-TTY, `--password`, ADMIN-exists). All throwaway containers,
  network and images removed; the dev Postgres/MinIO containers were untouched; no server was started on port 3000.
- `tsc`/`eslint` clean; full integration suite 273/273 (needed because the new test assumes the shared test
  DB holds no ADMIN); the unit suite was not rerun (no application code it covers changed).

**Limitations.** Verified only on a synthetic database — never against a real production database. The
interactive path was exercised through a pseudo-terminal (`script`) in the image, not by a human at a real
terminal. A disabled (non-ACTIVE) ADMIN still blocks bootstrap by design; there is no account recovery
beyond the app's password-reset flow (which needs real email — an owner activation task); if sign-in and reset
are both unavailable, operator-assisted recovery is an unresolved gap, deliberately not documented as a manual
step. The first ADMIN's email is unverified by design.

**Next milestone (CI): implemented host-neutral — see next sub-milestone.**

### Sub-milestone: pre-release verification (CI), host-neutral (2026-10-08)

**Blocker found first, and respected.** The repository has **no git remote, no `repository` field and no CI
configuration**, so the hosting platform cannot be established. No platform-specific workflow file (GitHub
Actions, GitLab CI, …) was written and no platform was chosen. Instead the whole pipeline is one portable
script any host's job can run: `bash scripts/ci/verify.sh` (runbook: `docs/ci.md`).

**Built.** `scripts/ci/verify.sh`, `ci/docker-compose.ci.yml` (disposable PostgreSQL 17 on tmpfs + MinIO,
ephemeral loopback ports, per-run synthetic credentials, unique compose project, removed on exit),
`scripts/ci/assert-integration-not-skipped.mjs`, `.nvmrc` (Node 24 = the production image), `docs/ci.md`.
Steps: `npm ci` (lockfile) → typecheck → lint → unit → start disposable services → `prisma migrate deploy`
against the disposable **test** database only → integration (existing isolation guard on; the script **fails if
the real-MinIO suite skipped**, because that suite skips silently when unconfigured) → e2e (existing config:
fake payments, local-preview email, blank S3; its `build && start` is the application-build gate, so there is
no redundant `npm run build`) → `docker build` runner + `--target migrate` → image smoke (migrate image on a
fresh DB, then boot the runner and poll `/api/health`). Safeguards: refuses to run if a `.env` exists,
refuses any non-loopback DB/S3 target, unsets inherited provider/test-bypass variables, bounds each step with
a timeout, always tears down. No deploy, publish, scheduler or production secret.

**Verified — locally only (NOT a hosted CI run).** The script was run end to end on a **clean copy** of the
working tree (tracked + untracked files, no `.env`, no `node_modules`, no `public/`), with `npm ci`:
**PASSED in 675 s** — typecheck, lint, unit 494/494, migrate (test DB only), integration 273/273 with
"MinIO suite ran for real: 10 passed, 0 skipped", e2e 40/40, both image targets built, migrate target applied
on a fresh database and the runner booted healthy. Cleanup left no containers, networks, volumes or images; the
developer's Postgres/MinIO containers and port 3000 were untouched. **No hosted CI service has run this**; do
not read any of the above as "CI is green". The workflow was not run against the owner's dev database or
storage (the preflight makes that impossible).

**What the clean-checkout run found (all fixed; each would have broken the first hosted run).**
- `Dockerfile` copied `public/`, which is empty — git does not track empty directories, so a real checkout has
  none and the image build would fail. The build stage now creates it.
- Two unit tests failed only in the clean environment: a Stripe webhook-signature test depends on the unit
  setup's own placeholder secret (the script exported a different synthetic one — the script now exports
  Stripe-shaped placeholders only after the unit step), and the xlsx archive-guard test builds a 150 MB
  fixture that takes ~5–11 s, over Vitest's 5 s default (timeout raised for that one test; the guard's own
  speed assertion is unchanged).
- **Integration tests could reach real Stripe.** Two `order-management` tests cancel a payment-less order, which
  searches the payment provider; with no injected gateway that resolved the real `StripePaymentGateway`. With only
  a synthetic key CI failed them ("Invalid API key"), which showed that on developer machines — where `.env` holds a
  Stripe TEST-mode key — those tests have been making read-only Stripe TEST-mode API calls (a search, no data
  created or changed) since the admin-cancel work. Fixed in the test setup: the integration suite now defaults to
  `FakeStripeGateway` (the same "safe global default" it already applies to both mailers); suites that need their
  own gateway still set it. Confirmed passing with an invalid Stripe key in the environment.
- My script's `S3_PUBLIC_BASE_URL` wrongly included the bucket (the app appends it) — corrected.

**Not gated / known gaps.** `npm run format:check` is not in the pipeline: it already fails on 83 files (a
one-off reformat is needed first). No dependency audit, header scan or load test. MinIO image tag is unpinned
(same as the dev compose file). Hosted-CI behaviours the local run cannot show: runner OS packages for
Chromium (`CI_PLAYWRIGHT_DEPS=1`), registry rate limits, runner resource limits (the 150 MB-fixture unit test and
the e2e build are the heaviest steps), and Docker availability on the chosen host.

**Activation requirements (owner/host side).** (1) Decide the CI host and create the remote repository;
(2) a read-only-checkout job on Node 24 + Docker Compose v2 running
`CI_PLAYWRIGHT_DEPS=1 bash scripts/ci/verify.sh`, with **no secrets**, job timeouts, and on failure only an
upload of `test-results/`/`playwright-report/` — never `.local/`, `.env*`, dumps or `.e2e-storage-objects/`;
(3) no registry-push or deploy credentials on this job; (4) the first hosted run is what will establish whether
CI is actually green.

**Smallest next milestone was: database backup and a verified restore drill — implemented (see next sub-milestone).**

### Sub-milestone: database backup and verified restore drill (2026-10-08)

**Built.** `scripts/db/backup.sh` (manual custom-format `pg_dump`, read-only; writes `.partial`, then
verifies and renames; deletes the partial on any failure; refuses output inside a git tree; sha256 sidecar),
`scripts/db/restore.sh` (restores **only** into a database it creates itself — `restore_*` name, explicit
confirmation, own `RESTORE_PG*` variables, refuses the app's server, checksum + readability gates, drops only what
it created on failure), `scripts/db/restore-drill.sh` (the repeatable drill), `scripts/db/verify-restore.ts`,
`scripts/db/drill-seed.ts`, shared `_common.sh`, and `docs/backup-restore.md`. Credentials come only from the
environment, are passed to the tools by name, and are never printed. `*.dump*` is git-ignored; `scripts/db/` is
excluded from the image. **The owner's dev database was never read, backed up, restored over or modified** — the
drill uses its own throwaway PostgreSQL container and refuses anything but a loopback `drill_*` database.

**Actually restored and verified (synthetic data, disposable server).** The seed used the application's own
services and the existing integration fixtures to build 3 users, 3 products/variants, 4 orders (an authenticated
paid order with two lines, a paid order with a partial refund, an open guest reservation, an admin-cancelled order),
2 payments, 1 refund, 14 stock movements and 11 audit rows (85 rows over 35 tables). It was backed up, then
restored into a separate, newly created, empty database:
- every table's row count **and a content fingerprint over each row's full text** equal source vs restored; schema
  parity (147 indexes, 79 constraints, 22 enum types); 41 foreign keys with no orphans; every order's
  `subtotal − discount + shipping + tax = total`; order/tax/shipping/item/payment/refund totals and paid-order count
  equal; per-SKU inventory equal (`36/0`, `23/5`, `8/0`); the app's own inventory reconciliation passes on the
  restored copy;
- the restored copy was read **through the application's Prisma client and services** (customer order history and
  order detail, admin order detail) with the same figures as the source; `prisma migrate status` reports the schema up
  to date (10 migrations);
- safeguards exercised and refused as designed (nothing changed): non-`restore_` name, wrong confirmation, target equal
  to the app's server, corrupt archive (checksum), missing checksum, unreadable archive, an **already existing**
  database (left untouched, data intact), and a restore that **fails after its database was created** (the
  database is dropped again — exercised with a `pg_restore` stub image, no test hook in the script); backup with a
  wrong password and with an in-repo output directory fail loudly and leave no file; the database password appears in
  none of the backup, restore or refusal output.
- Listing alone was **not** treated as proof; the drill passed end to end three times (earlier runs found and fixed
  harness issues only). Cleanup left no containers, networks or images; the owner's Postgres/MinIO containers and
  port 3000 were untouched. The drill's mail goes to in-memory fakes, so no email and no preview file is produced
  (an earlier draft used the default preview mailer; the 16 inert preview files it wrote — all for synthetic
  "Phase 5 Test" orders — were removed from `.local/email-previews/`, and nothing else there was touched).

**Test-isolation regression closed.** The two `order-management` tests flagged earlier (admin cancel of a
payment-less order) are now run under a network guard (`tests/integration/helpers/network-guard.ts`) with a Stripe
key deliberately present in the environment. It replaces the real Stripe adapter's methods, `http(s).request/get`,
global `fetch` and `net/tls.connect` with recorders that throw, so nothing can leave the machine; the file ends with
a test asserting zero attempts. Proven effective: with the old behaviour restored (real gateway), exactly those two
tests plus the isolation assertion fail with the attempt recorded (`StripePaymentGateway.findPaymentIntentForOrder`);
with the fake default, all 10 tests pass with zero attempts.

**Not done / limitations.** No schedule, retention, encryption, off-machine copy, named restore owner, or
point-in-time recovery; **product-image objects are not backed up** (separate, outstanding requirement); secrets are
out of scope; the cutover to a restored database is deliberately manual and un-rehearsed. All detail and the
decisions needed are in `docs/backup-restore.md` § "Remaining work". The drill's fixtures are synthetic; a real
restore of production-sized data (time, disk, locks) has not been measured.

**Next milestone (operational-error visibility): implemented — see next sub-milestone.**

### Sub-milestone: operational-error visibility (2026-10-08)

**Built (small, no platform).** `src/server/observability/logger.ts` — a shared JSON-lines logger (stdout for
info, stderr for warn/error; `ts`, `level`, `event`, `service`; zero imports and erasable-only syntax so the two
plain-`node` jobs can load it). Privacy is enforced centrally: sensitive field names are redacted whatever the value,
secret shapes (Stripe/Resend keys, webhook secrets, bearer/JWT, connection strings, emails) are scrubbed from
strings, non-primitive values are dropped, and **errors are logged as a category only** (`errorName` +
`errorCategory`), never message/stack/cause. Instrumented: the Stripe webhook (`stripe_webhook.rejected`,
`.not_configured`, `.processing_failed` with `eventId`/`eventType`/`stage` — the pre-transaction
`retrievePaymentIntent` failure, previously an unhandled exception, is now caught and logged; status stays **500**
so Stripe retries, and nothing is consumed); the three jobs (`job.started`, `job.completed` | `job.failed`, each with
`job`, `runId`, `durationMs`, plus per-category events for orders needing review/failing and uploads giving up —
order/upload ids only); and the library log sites on those paths that used to print raw `error.message` (email
dispatch kick, order-email send, image-upload cleanup). **Exit codes and retry semantics are unchanged** (crash →
1; order job also 1 on item errors or unset `PAYMENT_CLAIMS_ACTIVE_SINCE`; email and cleanup jobs still exit 0 on
partial/“attention” outcomes as before).

**Health.** `/api/health` is now strictly **liveness** (fixed body `{status, timestamp}`; the `environment` field was
removed as configuration disclosure; never touches the database). New `/api/health/ready` is **readiness**
(`SELECT 1` within 3 s → `200 {"status":"ready"}` / `503 {"status":"unavailable"}`; cause logged as a category only).
Added because liveness alone cannot tell "process up" from "can serve orders". The image `HEALTHCHECK` stays on
liveness on purpose (a database blip must not restart the web process). `docs/monitoring.md` is the runbook: log format
and event table, which probe for what, the detection rules for failed / **missing** job runs, unhealthy HTTP and
repeated webhook failures (same `eventId` ≥ 3), and what a host must provide.

**Verified (synthetic data, fake gateway, mocked transports; nothing left the machine).**
- Unit `logger.test.ts` (20): envelope + stdout/stderr levels, caller cannot spoof the envelope, redaction by field
  name, secret-shape scrubbing, drops objects, truncation, never throws, error → category only (even with a message full
  of keys/passwords/emails/connection string), job-run events and levels, readiness check incl. timeout.
- Integration `observability.integration.test.ts` (16): invalid signature → 400 + category-only warning; webhook failure
  both **before** and **inside** the transaction → 500, structured error with the event id, log scanned for 10
  representative leaks (API key, email, street address, postal code, JWT, connection string/password, webhook secret,
  provider text) — none present — then the **same event redelivered succeeds** (order PAID; the failure had consumed
  nothing); success/duplicate emit no failure events; health: liveness 200 with exactly `status`+`timestamp`, no config
  words, **no DB call**; readiness 200/503 with reason-free bodies and no leak; liveness stays 200 while readiness is 503;
  **the three jobs run as real child processes** against the isolated test DB: `job.started`→`job.completed` (same
  `runId`, `durationMs`), `skipped` for cleanup without S3, and — with an unreachable database whose URL contains a
  password — **exit code 1**, `job.failed` with a category, and the password/URL absent from all output. Mutation check:
  adding `error.message` to the webhook log makes the leak test fail; reverted.
- Existing suites touching the changed code still pass (payments, order-emails, product-images, refund, webhook scope:
  74; notifications/mailers/stripe-gateway/job-loadable units). One existing unit test that spied on `console.error` now
  asserts the structured event instead. `tsc` and `eslint` clean; the production build (Playwright smoke run: home +
  health) passes. The full suite was not rerun (no gate required it).
- Not exercised: the order job's non-zero exit when orders error / the claim cutoff is unset (needs orders and would
  call the real payment search; the logic is unchanged and only its message changed), a real host's log collection.

**Not done / honest limits.** No collector, retention, alert delivery, uptime checker, on-call owner or scheduler —
all pending activation (`docs/monitoring.md`). The generic API error wrapper's raw `console.error` was closed in the follow-up below. Logs are not exactly-once or tamper-evident.

#### Launch checklist (what remains between "built and locally verified" and "taking real orders")

**Remaining essential code work** (no confirmed blocker is open)
1. ~~Route the generic unhandled-API-error log through the shared logger~~ — done (see the follow-up below).
2. Fix whatever validation of the **new** payment-claim, provider-aware cancellation and recovery behaviour exposes when
   it first runs against Stripe **Test Mode** (idempotency retention/409/replay, cancel-refusal shapes, search lag).
   Earlier Stripe Test Mode checks already exist in this project — a Payment Element checkout and two real refunds
   (Phase 7/8 evidence above) — so this is *not* the project's first Test Mode run; only the behaviour added since is
   unverified against a live account. Scope unknowable until that run.

**Hosting / account / business decisions (owner)**
- Hosting platform, domain, DNS, TLS and reverse proxy; managed PostgreSQL (backups/PITR plan, schedule, retention,
  encryption, off-machine copy, named restore owner); object storage + public CDN URL and a recovery plan for
  **product-image objects** (not covered by database backups).
- Stripe live account and webhook endpoint; Resend account and verified sending domain.
- **Actual tax obligations/rates and shipping prices** for all of Canada (the 13% Ontario rate and $12 shipping are
  seed samples); whether a province with no tax configured should keep charging $0 or block checkout.
- Whether production runs the seed at all (it should not); who holds the first ADMIN credentials.
- CI host and remote repository; log collection, alert delivery, uptime checker and on-call owner; the scheduler for the
  three jobs.

**Deployment-time configuration and validation**
- Provide every variable in `docs/deployment.md` §2 (build args baked per environment); keep test/dev switches unset;
  run a **single** web instance until the rate limiter is shared.
- Take and verify a backup → `prisma migrate deploy` (separate step) → first-ADMIN bootstrap → probe `/api/health` and
  `/api/health/ready` → set `PAYMENT_CLAIMS_ACTIVE_SINCE` per the rollout-boundary procedure.
- Real-provider validation in the deployed configuration (Test Mode first): a payment through the deployed webhook
  URL, an abandoned-checkout cancellation and a payment-claim recovery (the new behaviour), a refund, a real email to a real
  inbox (verification, order confirmation, password reset), an image upload through the real bucket and CDN URL.
- Run each job once by hand, then schedule them and add the "no `job.completed` within 2.5× cadence" alerts; confirm a
  deliberately failing job and a failing webhook actually reach a human.
- First hosted run of `scripts/ci/verify.sh`; a restore rehearsal of the real database; a rollback exercise; a security-
  header scan against the deployed URL.

#### Follow-up: generic API error logging (2026-10-08)

`src/lib/http/api-response.ts` (the `route()` wrapper used by the 28 JSON API routes) logged unexpected errors with
`console.error("[api] unhandled error:", error)` — the raw error object. It now emits one structured event,
`api.unhandled_error`, with `method`, `path` (no query string), the proxy's `x-request-id` only when present and a plain
identifier (no id is invented — the app has none of its own), and `errorName` + `errorCategory`; never message, stack,
cause or properties. **HTTP statuses, response bodies, headers and validation behaviour are unchanged**, and expected typed
errors (auth, catalog, import, CSRF, validation) still produce no log line.
Verified (`tests/unit/api-response.test.ts`, 15): every error branch's status/body/header asserted — and those same
assertions also pass against the **previous** implementation (checked by swapping it back in); an unexpected error whose
message, properties and cause carry an API key, webhook secret, email, street address, postal code, JWT, connection string
and password (plus a request with query-string token, cookie, authorization header and body secrets) yields exactly one
useful event and **none** of it appears in the log, the response or `console`; a malformed `x-request-id` is dropped;
mutation check — restoring the raw `console.error` fails 3 tests. Typecheck and lint clean; no full-suite rerun.
**Still untested by design (documented, not hidden):** the `orders:expire-abandoned` job's *error-outcome* branch — a
run that finds orders which error, or whose cutoff (`PAYMENT_CLAIMS_ACTIVE_SINCE`) is unset — exits 1 by unchanged
logic and only its log wording changed in the last milestone; exercising it needs seeded stale orders and would call
Stripe's search API (no safe fake can be injected into a child process without a new harness), so it was deliberately not
run. Its crash path (unreachable database → `job.failed`, exit 1) *is* tested. **Confirmed essential code blocker open: none.**
Host requirements derived from the image and code: `docs/deployment.md` §7.

#### Local resource measurement (2026-10-13) — informs future low-cost hosting; NOT proof of capacity

One bounded, free, local run of the production image (built from the current working tree, 1.47 GB, linux/amd64) with
`postgres:17-alpine` (default settings) inside **one enforced cgroup: 2 GiB memory, swap disabled, 1 vCPU quota** on
Docker Desktop/WSL2 (16 logical CPUs). Web, Postgres and job containers shared the pool; each process was also given a
2 GiB cap so Node sizes itself as on a 2 GiB machine. No hosting provider is approved (DigitalOcean is only a candidate).
**Fake providers only through the existing guards:** `PAYMENT_GATEWAY=e2e-fake` and `EMAIL_TRANSPORT=local-preview` with
`E2E_DIST_DIR=.next-e2e` and `DATABASE_URL == TEST_DATABASE_URL` (a disposable database) — the image needed one symlink
`.next-e2e → .next` to satisfy the marker; no code or safeguard changed. Outbound DNS was blocked and the headless browser
aborted every non-local request (55 attempts to `js.stripe.com` blocked). Seed data only: 1 product, 4 variants, stock raised.

| Phase (workload) | Result |
| --- | --- |
| Idle (49 s) | web **72 MiB** (anon 65), Postgres 24, pool 96; CPU ≈ 0 |
| First journey (cold start) | web ≤ 135 MiB |
| Browse, 8 concurrent visitors, 250 ms think, 60 s | 1,343 requests, 0 errors, 22 req/s; p50 41–90 ms, p95 133–288 ms, max 545 ms; pool peak 265 MiB; 0.52 cores avg; 25 % of CPU periods throttled |
| Shoppers, 3 real browsers × 10 journeys (product → cart → checkout → order → payment page → confirmation), 46 s | 30/30 ok; step p50 144–194 ms, p95 ≤ 608 ms; pool peak 261 MiB |
| `emails:dispatch` (documented command), synthetic 62-email backlog | exit 0; 1.3 s job / 1.7 s wall; container peak 59 MB; empty queue 0.28 s job / 0.67 s wall |
| Combined, 92 s: 8 visitors + 3 shoppers (24 orders) + 2 job runs | 1,956 requests, 0 errors, p95 ≤ 316 ms; 24/24 journeys, p95 ≤ 912 ms; jobs 3.5 s and 2.2 s, exit 0; **pool peak 351 MiB** (web 261, Postgres 48), 0.66 cores avg, **43 % of CPU periods throttled** |
| Whole run (~7 min) | exact `memory.peak` 351 MiB (anon + kernel 321); **0 OOM / oom_kill / max events, 0 restarts, swap peak 0**, no web errors; headroom ≈ 1.69 GiB of the 2 GiB pool *before* OS/proxy. After load the web process kept ~246 MiB (did not shrink; 72 → ~270 MiB over the run — no soak, so the long-run trend is unknown) |

**Excluded or not measured — do not read the table as covering these:** the OS, Docker daemon, TLS reverse proxy, SSH and
monitoring agent (they share the same 2 GiB on a one-server layout; sizes unmeasured); real Stripe/Resend SDK paths,
payment finalisation, the webhook and the paid-order email kick (the fake gateway cannot finalise a payment, so orders
stayed PENDING and the job backlog was queued by SQL); login/registration (Argon2id ≈ 19 MiB per concurrent hash; the rate
limiter was left intact); image upload (`sharp`); CSV/XLSX import (up to 5 MB in memory); admin pages; S3 storage and
**local image storage (still not approved for production — not exercised)**; the other two jobs (`orders:expire-abandoned`
needs Stripe search; `images:cleanup-uploads` is skipped without S3); building the image on a small server (built on the
16-CPU host). Postgres held a few hundred rows, so its numbers are a floor. WSL2 CPU is not a shared cloud vCPU; latencies
here are likely optimistic. **What it supports:** at this light load the web + Postgres working set peaked near 0.35 GiB,
far from 2 GiB, with sub-second responses and no failures, while the 1-vCPU quota was throttled 25–43 % of the time.
**What it does not:** any capacity claim, or a verdict on a 1 GiB server (untested).
Cleaned up: the measurement's containers, volume, network, cgroup and images. The BuildKit build cache remains (not
pruned: it is shared with any other build).

---

### Original Phase 13 scope and acceptance criteria

**Scope**

- `Dockerfile` (non-root; **done**, see above — not `standalone`) + CI/CD pipeline.
  
- Security headers / CSP in middleware; rate limiting.
- Structured logging, error tracking, uptime + health monitoring.
- Backup/restore runbook; expand/contract migration policy documented.
- Load test of catalogue + checkout; performance budget enforced.

**Acceptance criteria**

- [ ] Image builds in CI and boots with only documented env vars. _(builds and boots locally with the documented env vars; CI not set up)_
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
