# Taek Shops — Architecture

> Status: **Phase 1 (foundation)**. This document is the design of record. Where a
> section describes something not yet built, it is marked _Planned_. Nothing here
> commits the project to legal, tax, or shipping rules — those are provider
> concerns behind interfaces (see §11, §12).

## 1. System context

Taek Shops is a single, deployable **Next.js (App Router) application** backed by
one **PostgreSQL** database. It serves two audiences from the same codebase:

| Actor             | Surface                         | Notes                                            |
| ----------------- | ------------------------------- | ------------------------------------------------ |
| Shopper (guest)   | Storefront                      | Browse catalogue, cart, guest checkout           |
| Customer          | Storefront + account area       | Order history, addresses, re-order               |
| Staff / Admin     | Admin dashboard                 | Catalogue, inventory, orders, spreadsheet import |
| Payment provider  | Stripe (server + webhook)       | External; behind `PaymentGateway` interface      |
| Object storage    | S3-compatible bucket + CDN      | External; behind `ObjectStorage` interface       |
| Tax provider      | Pluggable (manual or external)  | Behind `TaxCalculator` interface                 |
| Shipping provider | Pluggable (flat or carrier API) | Behind `ShippingRateProvider` interface          |

External dependencies are deliberately minimal and each sits behind a
replaceable interface so the platform is not locked to a vendor.

```
        ┌─────────────────────────── Next.js app (single deploy) ────────────────────────────┐
Browser │  Storefront (RSC)      Admin (RSC, auth-gated)      Route Handlers / Server Actions │
  ─────▶│        │                      │                              │                     │
        │        └──────────────┬───────┴───────────────┬──────────────┘                     │
        │                       ▼                       ▼                                    │
        │                 Domain services         Import pipeline                            │
        │                       │                       │                                   │
        │                       └───────── db (Prisma) ─┘                                    │
        └───────────────────────────────┬───────────────────────────────────────────────────┘
                                        ▼
                       PostgreSQL          Stripe API / webhooks
                       S3-compatible storage + CDN
```

## 2. Major application modules

| Module             | Location                       | Responsibility                                                       |
| ------------------ | ------------------------------ | -------------------------------------------------------------------- |
| Storefront         | `src/app/(storefront)/`        | Public catalogue, product pages, cart, checkout UI                   |
| Administration     | `src/app/admin/`               | Auth-gated dashboard: products, variants, inventory, orders, imports |
| Authentication     | `src/server/auth/`             | Auth.js config, session, role guards                                 |
| Domain logic       | `src/server/domain/`           | Pricing, cart, inventory, orders, tax/shipping orchestration         |
| Database access    | `src/server/db/`               | Prisma client + repositories; only module that touches the DB        |
| Validation schemas | `src/lib/validation/`          | Shared Zod schemas + inferred types                                  |
| Import processing  | `src/server/import/`           | CSV/XLSX parse → map → validate → preview → commit → audit           |
| Config             | `src/server/config/`           | Validated environment configuration (`env.ts`)                       |
| Shared UI          | `src/components/`              | Accessible, responsive component system                              |
| Infrastructure     | `infra/`, `docker-compose.yml` | Local services, deployment assets                                    |
| Tests              | `tests/unit/`, `tests/e2e/`    | Vitest unit/integration, Playwright end-to-end                       |

**Import boundaries (enforced by convention, later by lint rules):**

- `src/app/**` may import from `src/components`, `src/lib`, and `src/server`.
- `src/components/**` must not import from `src/server/**`.
- Only `src/server/db/**` imports the Prisma client.
- `src/server/config/env.ts` is the only reader of `process.env`.

## 3. Authentication & authorization model _(Planned)_

- **Library:** Auth.js (NextAuth v5) with the Prisma adapter.
- **Session strategy:** database sessions (needed for immediate revocation of
  staff access).
- **Credential model:** email + password for customers (Argon2id hashing) and
  staff. OAuth providers can be added later without schema change.
- **Roles:** `customer`, `staff`, `admin` stored on the `User` record.
  - `customer` — own account and orders only.
  - `staff` — read/write catalogue, inventory, orders; run imports.
  - `admin` — everything staff can do, plus user management and destructive
    operations.
- **Enforcement points:**
  1. `middleware.ts` — coarse gate: redirect unauthenticated users away from
     `/admin/**` and `/account/**`.
  2. Server-side guards (`requireUser`, `requireStaff`, `requireAdmin`) in every
     admin route handler, server action, and admin page — the authoritative check.
  3. Domain services never trust the caller; sensitive mutations take an explicit
     actor argument used for audit logging.
- **CSRF:** server actions use the framework's built-in origin checks; custom
  route handlers that mutate require same-origin + auth.

## 4. Database boundaries

- **One PostgreSQL database**, one Prisma schema. No microservices, no per-module
  databases at this stage.
- **Logical schema groups** (same DB, namespaced by model prefix / Prisma
  `@@map`):
  - _Identity_: `User`, `Account`, `Session`, `VerificationToken`.
  - _Catalogue_: `Category`, `Brand`, `Product`, `ProductVariant`,
    `VariantAttribute`, `ProductImage`.
  - _Inventory_: `InventoryItem`, `StockMovement`.
  - _Commerce_: `Cart`, `CartItem`, `Order`, `OrderItem`, `Address`, `Payment`,
    `Shipment`.
  - _Operations_: `ImportBatch`, `ImportRow`, `AuditLog`.
- **Access rule:** application code calls repository functions in
  `src/server/db/`, not the Prisma client directly. This keeps query patterns
  reviewable and makes it possible to add caching or read replicas later.
- **Migrations:** Prisma Migrate; every schema change ships as a checked-in
  migration. `DIRECT_DATABASE_URL` supports running migrations against a
  non-pooled connection.
- **Money:** stored as integer **cents** (`Int`) in CAD, never floats. A
  `Money` value object in the domain layer wraps arithmetic and formatting.

## 5. Product & variant model

A **Product** is the catalogue entity a shopper lands on. A **ProductVariant** is
the buyable unit and the thing that carries a **SKU**, price, and stock.

```
Category ─┬─< Product >─┬─< ProductVariant >──1─ InventoryItem
Brand ────┘             ├─< ProductImage
                        └─< VariantAttribute (typed key/value)
```

- **Product**: `name`, `slug`, `description`, `category`, optional `subcategory`
  (self-referential category), `brand`, `productType` (e.g. `uniform`, `belt`,
  `sparring_gear`, `training_equipment`, `accessory`), `taxCategory`, `active`.
- **ProductVariant**: `sku` (unique, immutable business key), `variantName`,
  attribute set, `salePriceCents`, optional `compareAtPriceCents`, optional
  `costPriceCents`, `weightGrams`, optional `barcode`, `active`.
- **VariantAttribute**: typed dimensions rather than free text —
  `size`, `colour`, `gender` (`mens|womens|unisex|youth`),
  `ageGroup` (`adult|youth|child`), plus equipment-specific attributes
  (e.g. `beltRank`, `protectiveArea`). Enumerations live in the domain layer and
  are validated on write.
- A product with no meaningful variation still has exactly one variant (the
  default), so pricing/stock logic has a single code path.
- **Pricing:** `salePriceCents` is authoritative. `compareAtPriceCents` is
  display-only ("was" price). `costPriceCents` is internal (margin reporting),
  never sent to the storefront.

## 6. Inventory model

- Each `ProductVariant` has one `InventoryItem` with `onHand`, `reserved`, and a
  derived `available = onHand - reserved`.
- `low_stock_threshold` per item drives admin alerts; it does not block sales.
- **Every quantity change is a `StockMovement`** (`type`: `receive`, `sale`,
  `return`, `adjustment`, `import`; `delta`; `reason`; `actorId`;
  `sourceRef`). `onHand` is the sum of movements — the ledger is the source of
  truth, the column is a cache updated in the same transaction.
- **Reservation:** stock is reserved when an order is placed (payment intent
  created) and either committed on payment success or released on
  cancellation/expiry.
- **Overselling:** guarded at checkout inside the order transaction with a
  conditional update (`available >= qty`); no optimistic UI promises.
- Phase 1 does not implement this; the model is fixed now so the import pipeline
  and checkout can rely on it.

## 7. Spreadsheet import pipeline

Full column and rule specification: **`docs/product-import-specification.md`**.

Pipeline stages (all under `src/server/import/`):

1. **Upload** — admin-only route handler. Enforce `IMPORT_MAX_FILE_SIZE_BYTES`,
   MIME/extension allow-list (`text/csv`, `.csv`,
   `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `.xlsx`),
   and store the raw file in object storage under a batch id.
2. **Parse** — stream CSV (`csv-parse`) or read XLSX (`exceljs`, not `xlsx`/SheetJS)
   with a hard `IMPORT_MAX_ROW_COUNT` cap. Reject workbooks with macros.
3. **Sanitise** — neutralise **formula injection**: any cell whose value begins
   with `= + - @` or tab/CR is prefixed with `'` on export and rejected/escaped
   on import; never evaluate cell formulas.
4. **Map columns** — auto-match headings to canonical fields; present an
   override UI when headings differ. Mapping is stored with the batch.
5. **Validate** — per-row Zod schema. Collect **all** errors per row (row number,
   column, message, offending value). No partial silent coercion of prices or
   quantities.
6. **Preview** — show create / update / skip counts and a diff per row. Nothing
   is written yet.
7. **Commit** — on explicit confirmation, process in chunked transactions:
   - **Upsert by `sku`** (unique key). Modes: `create` (insert new, skip
     existing), `update` (update existing, skip new), `upsert` (both).
   - Duplicate `sku` within the same file is a hard error for that row.
   - Price and stock changes are applied via the domain services
     (`PricingService`, `InventoryService`) so `StockMovement` rows and audit
     entries are written atomically with the change.
   - A failed row does not abort the batch; it is recorded and reported.
8. **Summarise & audit** — write `ImportBatch` (status, counts, duration,
   actor, file ref) and one `ImportRow` per input row (status + errors).
   Downloadable error report (CSV) for failed rows.

**Security controls specific to import:** size/row caps (configurable, not
hard-coded), extension + MIME check, no formula evaluation, formula-injection
neutralisation, streamed parsing to bound memory, admin-role gate, rate limiting,
and audit logging of every batch.

## 8. Image-storage approach

- **Originals** live in an **S3-compatible bucket** (`ObjectStorage` interface:
  `put`, `getSignedUploadUrl`, `delete`, `publicUrl`). Local dev can point at
  MinIO; production at AWS S3 / Cloudflare R2 / Backblaze B2 — no code change.
- **Upload flow (admin):** browser requests a short-lived signed PUT URL →
  uploads directly to storage → server records a `ProductImage` row
  (`storageKey`, `alt`, `position`, `width`, `height`).
- **Delivery:** Next.js `<Image>` with a configured remote pattern pointing at
  the bucket's CDN domain (`S3_PUBLIC_BASE_URL`). Responsive sizes handled by
  the Next image optimizer.
- **Import references:** `image_url` in a spreadsheet is fetched server-side
  during a background job (allow-listed hosts, size cap, content-type check) and
  re-stored in the bucket; the sheet is never trusted to point the storefront at
  an arbitrary external URL.

## 9. Checkout & order flow _(Planned)_

```
Cart ─▶ Address & shipping method ─▶ Tax + shipping quote ─▶ Review
     ─▶ Create Order (status=pending) + reserve stock (single txn)
     ─▶ Create Stripe PaymentIntent ─▶ Client confirms payment
     ─▶ Webhook: payment_intent.succeeded ─▶ Order status=paid, commit stock,
        emit confirmation ─▶ Fulfilment
     ─▶ Webhook failure / expiry ─▶ Order status=cancelled, release stock
```

- **Order is authoritative, not the cart.** Totals are recomputed server-side at
  order creation from current prices; the client cannot set prices.
- **Idempotency:** order creation and webhook handling are idempotent
  (idempotency key on PaymentIntent creation; event id de-dupe on webhooks).
- **Guest checkout** supported; an account can be created post-purchase and linked
  by email.
- **Order states:** `pending → paid → fulfilled → completed`, with
  `cancelled` and `refunded` branches. Transitions are a domain state machine,
  each writing an `AuditLog` entry.

## 10. Payment boundary

- Interface `PaymentGateway` in the domain layer:
  `createPaymentIntent`, `confirmFromWebhook`, `refund`, `verifyWebhookSignature`.
- **Stripe** is the first implementation (`src/server/domain/payments/stripe.ts`).
- **No card data touches our servers or database.** The browser talks to Stripe
  via Stripe.js / Payment Element; we store only the PaymentIntent id, status,
  amount, and last-4/brand returned by Stripe.
- Webhook endpoint verifies signatures with `STRIPE_WEBHOOK_SECRET`; unverified
  events are rejected and logged.
- All secret keys are server-only env vars; only
  `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` reaches the client.

## 11. Tax boundary

- Interface `TaxCalculator`: `quote(lineItems, shipTo, taxCategories) → TaxBreakdown`.
- **The platform ships no tax rates.** Implementations:
  - `ConfiguredRateTaxCalculator` — rates supplied by the business via admin
    configuration / env, stored in a `TaxRate` table keyed by province and tax
    category. Rates are data, entered by the operator, never committed to source.
  - `ExternalTaxCalculator` — adapter for a third-party tax service, added if/when
    required.
- Tax category per product (`tax_category` column, e.g. `standard`,
  `exempt`, `childrens_clothing`) lets the operator model category-specific
  Canadian rules without the codebase asserting what those rules are.
- Tax is quoted at checkout and frozen onto the `Order`.

## 12. Shipping boundary

- Interface `ShippingRateProvider`: `rates(parcel, shipFrom, shipTo) → ShippingOption[]`.
- Implementations:
  - `FlatRateShippingProvider` — operator-configured rules (by province, weight
    band, order subtotal, free-shipping threshold). Rules are data.
  - `CarrierApiShippingProvider` — adapter for a carrier/aggregator API, added
    later.
- `weight_grams` on every variant feeds parcel weight.
- Selected option and price are frozen onto the `Order`.

## 13. Security controls

| Area              | Control                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| Configuration     | All env vars validated at startup (`src/server/config/env.ts`); fail fast; no secret defaults    |
| Secrets           | Server-only; never imported into client bundles; `.env` git-ignored; `.env.example` names only   |
| AuthN             | Auth.js, Argon2id password hashing, database sessions, revocable staff access                    |
| AuthZ             | Middleware gate + mandatory server-side role guards on every admin/account operation             |
| Transport         | HTTPS enforced at the edge; HSTS; secure, `HttpOnly`, `SameSite` cookies                         |
| Input validation  | Zod at every trust boundary (forms, route handlers, server actions, import rows)                 |
| Output / XSS      | React escaping by default; no `dangerouslySetInnerHTML` without sanitisation                     |
| SQL injection     | Prisma parameterised queries only; no raw string SQL                                             |
| CSRF              | Server-action origin checks; same-origin + auth on mutating route handlers                       |
| File upload       | Extension + MIME allow-list, size/row caps, streamed parsing, stored out of web root             |
| Formula injection | Import cells starting with `= + - @` neutralised; formulas never evaluated                       |
| Payment data      | Never stored; PCI scope minimised via Stripe-hosted elements                                     |
| Rate limiting     | Auth endpoints, import upload, webhook — token-bucket per IP / per user                          |
| Headers           | CSP, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options` via `next.config`/middleware |
| Auditing          | `AuditLog` for admin mutations, imports, order state changes, auth events                        |
| Dependencies      | Lockfile committed; `npm audit` in CI; Dependabot/Renovate later                                 |
| PII               | Minimal collection; no real customer/business data in fixtures or seeds                          |

## 14. Testing strategy

| Layer               | Tool                                        | Scope                                                                                                                |
| ------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Unit                | Vitest                                      | Domain logic (pricing, cart totals, inventory ledger), validation schemas, import row parsing/sanitisation, `env.ts` |
| Component           | Vitest + Testing Library + jsdom            | Synchronous UI components, accessibility roles/labels                                                                |
| Integration         | Vitest against a real Postgres (docker)     | Repositories, import commit transactions, order creation                                                             |
| End-to-end          | Playwright (Chromium; Firefox/WebKit in CI) | Storefront browse→cart→checkout (Stripe test mode), admin login, import happy path + error report                    |
| Contract / boundary | Vitest with fake gateway impls              | `PaymentGateway`, `TaxCalculator`, `ShippingRateProvider` conform to interface                                       |
| Static              | `tsc --noEmit`, ESLint, Prettier            | Every commit / CI run                                                                                                |

- **Definition of done for a phase:** its acceptance criteria in the roadmap are
  met, new code has tests, and the full verification pipeline
  (`format:check → lint → typecheck → test → build`) passes.
- Test data is synthetic. No production dumps.
- CI runs the pipeline on every push; e2e runs on PRs to the main branch.

## 15. Deployment architecture

- **Build:** `next build` with `output: "standalone"` → minimal Node server
  bundle.
- **Container:** multi-stage `Dockerfile` (deps → build → runtime on
  `node:22-alpine`, non-root user). Single image promoted across environments;
  runtime configuration entirely via env vars (no `NEXT_PUBLIC_` value baked in
  that differs per environment, or it is set at build time per environment).
- **Runtime services:**
  - App container(s) behind a load balancer / platform router.
  - Managed PostgreSQL (with automated backups + PITR).
  - S3-compatible bucket + CDN for images.
  - Stripe (SaaS).
- **Database migrations** run as a pre-deploy step (`prisma migrate deploy`)
  against `DIRECT_DATABASE_URL`.
- **Environments:** `development` (local + docker Postgres), `preview`/`staging`
  (Stripe test mode), `production` (Stripe live). Each has its own secrets store.
- **Observability:** structured JSON logs, health endpoint (`/api/health`),
  error tracking (Sentry or equivalent) and uptime checks — wired in the
  hardening phase.
- **Rollback:** redeploy previous image; migrations written to be
  backward-compatible for one release (expand/contract).

## 16. Key technical decisions & trade-offs

| Decision                                             | Rationale                                                                                                   | Trade-off / revisit trigger                                             |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Single Next.js app (modular monolith), no services   | Small team, one product; simplest thing that meets every requirement                                        | If admin/import load competes with storefront, extract a worker/service |
| App Router + React Server Components                 | Less client JS, straightforward data loading, first-class in Next 16                                        | Async Server Components can't be unit-tested — covered by e2e instead   |
| PostgreSQL + Prisma                                  | Relational data (orders, inventory ledger) wants transactions & FKs; Prisma gives typed access + migrations | Prisma raw-SQL escape hatch used sparingly for hot queries              |
| Prisma client only in `src/server/db`                | Keeps queries reviewable; enables later caching/replicas                                                    | Slight indirection cost                                                 |
| Money as integer cents (CAD only for now)            | Avoids float errors; matches Stripe's smallest-unit model                                                   | Multi-currency needs a currency column + FX policy later                |
| Typed variant attributes (not free-text)             | Enables faceted search, clean filters, reliable import validation                                           | Adding a new attribute type is a schema migration                       |
| `exceljs` + `csv-parse` for import (not SheetJS)     | Streaming, actively maintained, smaller supply-chain risk                                                   | Fewer exotic format features                                            |
| Everything behind provider interfaces (pay/tax/ship) | Requirement; avoids vendor lock-in; testable with fakes                                                     | A little upfront abstraction before the second implementation exists    |
| Auth.js database sessions                            | Immediate staff revocation, adapter matches Prisma                                                          | Extra DB read per request vs. JWT — acceptable at this scale            |
| Tailwind CSS v4                                      | Fast styling, ships with the scaffold, good for a design-token system                                       | Utility-heavy markup; mitigated by the shared component layer           |
| npm (not pnpm/yarn)                                  | Available in the environment; lockfile committed                                                            | Switch is low-cost if the team prefers pnpm                             |
| No i18n library yet, but "multilingual-ready"        | Avoid premature complexity; keep copy in components extractable                                             | Introduce `next-intl` when a second locale (fr-CA) is scheduled         |
