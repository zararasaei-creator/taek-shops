# Taek Shops — Catalogue, Inventory & Import

> Status: **Phases 4–5 implemented.** Product catalogue, variants/options, admin
> management UI, image-storage abstraction, the CSV import foundation, and the
> hardened inventory domain (row-locked transactions, reconcilable two-column
> ledger, DB CHECK constraints, order-lifecycle wiring). Cart & checkout (Phase 6)
> are in `src/server/cart` + `src/server/orders/checkout-service.ts`; payments
> and order management are later phases.

## 1. Catalogue architecture

Layered, following the Phase 3 pattern:

| Layer          | Location                                                   | Responsibility                                        |
| -------------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| Validation     | `src/lib/validation/catalog.ts`                            | Zod schemas (SKU/slug/money shape)                    |
| Services       | `src/server/catalog/*-service.ts`                          | Authorization + business rules + audit + transactions |
| Public queries | `src/server/catalog/catalog-queries.ts`                    | Storefront reads, status-filtered                     |
| Transport      | `src/app/api/admin/catalog/**`, `src/app/admin/catalog/**` | Route handlers + server actions + pages               |

Every service function takes `(actor, input, db?)`, calls `requirePermission(actor, …)`
**first**, validates with Zod, mutates (inside `$transaction` where multiple
writes must be atomic), and writes an `AuditLog` entry. The UI and proxy are
never the authorization boundary.

### Permissions (from Phase 3)

| Capability                                                            | Permission                        | Roles                 |
| --------------------------------------------------------------------- | --------------------------------- | --------------------- |
| Read catalogue / inventory                                            | `catalog.read` / `inventory.read` | STAFF, MANAGER, ADMIN |
| Create / edit products, variants, options, brands, categories, images | `catalog.write`                   | MANAGER, ADMIN        |
| Adjust inventory                                                      | `inventory.write`                 | MANAGER, ADMIN        |
| Run product imports                                                   | `import.run`                      | MANAGER, ADMIN        |

## 2. Product / variant / options model

Uses the **Phase 2 normalised schema unchanged** except one additive integrity
column (§8):

```
Brand ─┐
        ├─< Product >─┬─< ProductOption >──< ProductOptionValue >─┐
Category┘             │                                          │
                      ├─< ProductVariant >──< ProductVariantOptionValue >┘
                      │        │
                      │        └──1─ InventoryItem ──< StockMovement
                      └─< ProductImage
```

- **Product** — `name`, unique `slug`, `description`, `status`
  (`DRAFT` / `ACTIVE` / `ARCHIVED`), `active` (mirrors `status === ACTIVE`),
  `featured`, optional `brandId` / `categoryId`, `taxCategory` (free-text
  classifier), SEO fields, `publishedAt`.
- **ProductOption / ProductOptionValue** — arbitrary named options
  (Size, Colour, Style, Gender, Material, …). Not limited to Size/Colour.
  `@@unique([productId, name])`, `@@unique([optionId, value])`.
- **ProductVariant** — unique `sku`, optional unique `barcode`, `priceCents`
  (integer cents), optional `compareAtPriceCents` / `costCents`, `currency`
  (`CAD`), `weightGrams`, `active`, `trackInventory`, `optionSignature` (§8).
- **ProductVariantOptionValue** — join; `@@unique([variantId, optionId])`
  (one value per option per variant).

### Variant invariants (enforced application + DB)

1. **Unique SKU** — DB `@unique` + a friendly pre-check.
2. **Complete option coverage** — a variant must select exactly one value for
   **every** option the product defines (`resolveSelections`).
3. **No duplicate option combinations** — `optionSignature` + DB
   `@@unique([productId, optionSignature])`.
4. **`compareAtPrice > price`** when set.
5. **Exactly one `InventoryItem`** per variant (created with the variant).
6. Options are **locked once variants exist** — remove the variants to change
   the option set. The importer is the exception (it upserts options + variants
   per row).

## 3. Product lifecycle

`DRAFT → ACTIVE → ARCHIVED` and any reverse. Transitions go through
`changeProductStatus` / the update path:

- **→ ACTIVE requires ≥ 1 active variant.** A product with no sellable variant
  cannot be published.
- `publishedAt` is stamped on first activation; `active` is kept in sync.
- **Public queries** (`catalog-queries.ts`) return a product only when
  `status = ACTIVE` **and** `active = true` **and** it has an active variant.
  Draft/archived products are structurally unreachable from the storefront API.
- Products referenced by orders are **archived, never hard-deleted**
  (`deleteProductIfUnused` refuses when `orderItems > 0`). Same rule for brands
  and categories with references.

## 4. Inventory adjustment rules

`src/server/inventory/inventory-service.ts` is the **only** place stock changes.
There are no ad-hoc `quantityOnHand` writes elsewhere.

- **`adjustInventory`** is the single manual entry point: identify by `sku` or
  `variantId`, then either `delta` (signed) or `setOnHand` (absolute), plus a
  required `reason`, a movement `type` (`ADJUSTMENT` / `PURCHASE` / `RETURN` /
  `INITIAL`), and an optional `reference`.
- Runs in a transaction: reads the item, computes the delta, updates
  `quantityOnHand`, writes a `StockMovement`, all atomically.
- **Hard rules — never silently violated** (enforced in the service **and** by
  `CHECK` constraints on `InventoryItem`, migration `20260906000000_phase5_inventory`):
  - `quantityOnHand` is never negative;
  - `quantityReserved` is never negative;
  - `quantityOnHand` is never dropped below `quantityReserved` (that would make
    an existing reservation unfulfillable);
  - `available = quantityOnHand − quantityReserved` is derived, never stored;
  - quantities are integers.
- Every adjustment writes an `AuditLog` entry (`inventory.adjusted` /
  `inventory.received`).

### Concurrency & the ledger invariant (Phase 5)

- **Row locking.** Every mutating transaction calls `lockInventoryItem` first —
  `SELECT … FOR UPDATE OF "InventoryItem"`. Concurrent writers to the same
  variant serialize on that lock, so the availability check and the write that
  depends on it are atomic. Overselling and lost updates are impossible;
  READ COMMITTED plus the lock is sufficient (no SERIALIZable retries).
- **Two-column ledger.** `StockMovement` carries a signed `quantityDelta`
  (on-hand) **and** `reservedDelta` (reserved). Both counters are fully
  reconstructable:

  ```
  quantityOnHand   == SUM(quantityDelta)
  quantityReserved == SUM(reservedDelta)
  ```

  | Movement                    | quantityDelta | reservedDelta |
  | --------------------------- | ------------- | ------------- |
  | INITIAL / PURCHASE / RETURN | +qty          | 0             |
  | ADJUSTMENT                  | ±qty          | 0             |
  | RESERVATION                 | 0             | +qty          |
  | RELEASE                     | 0             | −qty          |
  | SALE (commit)               | −qty          | −qty          |

  `GET /api/admin/inventory/health` reconciles every item against this invariant
  (`src/server/inventory/invariant.ts`).

- **Idempotent movements.** The order primitives pass a deterministic
  `StockMovement.idempotencyKey` (`order:<id>:<op>:<variantId>`, unique index);
  a replayed operation is a no-op, never a duplicate movement.

### Order-flow primitives (wired to the order lifecycle in Phase 5)

`reserveStockTx`, `releaseReservationTx`, `commitReservationTx`, `restockTx`,
`setOnHandTx` — transaction-composable, all row-locked and idempotency-aware.
`src/server/orders/order-inventory.ts` composes them into per-order operations
(`reserveOrderStock` / `commitOrderStock` / `releaseOrderStock` /
`restockOrderStock`) and `applyOrderStatusTransition`, which validates an
`OrderStatus` transition and applies the matching inventory effect atomically.
Order _creation_ and the full order state machine remain Phase 6 / Phase 8.

## 5. Admin catalogue UI

Under `/admin/catalog` (gated STAFF+ by the admin layout; mutations gated
MANAGER+ by the services):

| Page                           | What it does                                                         |
| ------------------------------ | -------------------------------------------------------------------- |
| `/admin/catalog`               | Overview + counts                                                    |
| `/admin/catalog/products`      | List, search, status filter, pagination                              |
| `/admin/catalog/products/new`  | Create a product (+ optional default variant)                        |
| `/admin/catalog/products/[id]` | Edit details, brand/category, options, variants, status, view images |
| `/admin/catalog/brands`        | List + create/edit                                                   |
| `/admin/catalog/categories`    | List + create (parent, sort order)                                   |
| `/admin/catalog/inventory`     | Low-stock list, adjustment form, recent movements                    |
| `/admin/catalog/import`        | CSV upload → preview → commit                                        |

Mutations use **server actions** (`src/app/admin/catalog/actions.ts`) which get
Next.js's built-in CSRF protection; the JSON API routes use `guardMutation`
(same-origin + double-submit token). STAFF users see read-only views.

## 6. Brand & category management

- `Brand` and `Category` remain their own normalised models — **never** collapsed
  into a `Product.brand` string.
- Create / edit / list / activate / archive via the service + admin pages.
- **Destructive protection:** a brand or category with referencing products (or
  sub-categories) cannot be hard-deleted — the operator deactivates it instead.
- Category cycles are rejected (`assertParentValid` walks the ancestry).

## 7. Product images — foundation

- **`ObjectStorage` interface** (`src/server/storage/object-storage.ts`):
  `put` / `get` / `delete` / `exists` / `publicUrl` / `createSignedUpload`.
- **`LocalObjectStorage`** (dev/test) writes to `./storage/objects` (git-ignored)
  and is served by `GET /api/media/[...key]` with path-traversal protection.
- **`getObjectStorage()`** (`src/server/storage/index.ts`) is the single switch
  point: it selects an S3-compatible backend when `S3_*` env is fully configured,
  otherwise local. The S3 backend implementation is a later phase — the factory
  currently logs and falls back to local when `S3_*` is set.
- `ProductImage.url` stores a **reference**, not binary data:
  `storage:<key>` for hosted objects (resolved via `ObjectStorage.publicUrl`) or
  an absolute `https://` URL for externally hosted images. Binary image data is
  never stored in PostgreSQL.
- `image-service.ts` handles add / upload (type + size validation) / update /
  remove / reorder / primary-image behaviour, with audit events.
- **Remaining integration:** the S3-compatible `ObjectStorage` implementation,
  signed direct-upload wiring, and the admin image-upload UI. The data model,
  interface, dev backend, and API are in place.

## 8. Schema change in Phase 4

One **additive** column (migration `20260905000000_phase4_catalog`), no Phase 2
model altered or removed:

```prisma
model ProductVariant {
  // ...
  optionSignature String @default("")
  @@unique([productId, optionSignature])
}
```

`optionSignature` = the variant's selected `optionValue` ids, de-duplicated,
sorted, joined by `|` (`""` for a product with no options). The composite unique
constraint makes duplicate option combinations per product impossible at the
database level. It is maintained by the variant service inside the same
transaction as any option-value change.

_Flagged for CTO review (§24 of the delivery report)._

## 9. Product import workflow (CSV)

`src/server/import/`. Ten stages, per the CTO requirement:

| #   | Stage                                                        | Where                                     |
| --- | ------------------------------------------------------------ | ----------------------------------------- |
| 1   | File/input validation (size, non-empty)                      | route + `parseCsv`                        |
| 2   | Header/schema validation (required columns, duplicates)      | `previewImport`                           |
| 3   | Row parsing (streaming-friendly, capped)                     | `parseCsv` (`csv-parse`)                  |
| 4   | Normalisation (slug derivation, money → cents, option pairs) | `parseProductRow`                         |
| 5   | Business validation (per-row, all errors collected)          | `parseProductRow`                         |
| 6   | Preview / dry-run (**no catalogue writes**)                  | `previewImport`                           |
| 7   | Row-level error reporting                                    | `ImportJobRow.errors` + preview UI        |
| 8   | Controlled commit (per-row transaction, upsert by SKU)       | `commitImport`                            |
| 9   | Import summary (created / updated / skipped / failed)        | `ImportCommitResult` + `ImportJob` counts |
| 10  | Auditability (`ImportJob` + `ImportJobRow` + `AuditLog`)     | throughout                                |

### Behaviour guarantees

- **Dry-run mutates nothing.** `previewImport` parses, validates, classifies, and
  persists an `ImportJob` (status `VALIDATED`) with one `ImportJobRow` per input
  row (staged cell values in `rawData`, errors in `errors`). It performs **zero**
  writes to `Product` / `ProductVariant` / `Brand` / `Category` / inventory.
- **Never a silent partial import.** `commitImport` processes each row in its own
  transaction. A failing row rolls itself back, is marked `FAILED` with a
  message, and the remaining rows continue. The `ImportJob` records exact counts
  and an `errorSummary`.
- **Server-side validation cannot be bypassed.** `commitImport` re-runs
  `parseProductRow` on the staged cell values — spreadsheet content is validated
  again at commit time, not trusted from the preview.
- **Formula / spreadsheet injection.** Every cell is read as text and passed
  through `neutralizeForImport` (strips control characters and any leading
  `= + - @` trigger). Formulas are never evaluated. Values written back out
  (template, error report) are `'`-prefixed if they would trigger a formula.
- **Idempotency.** Upsert is keyed on `sku` (variant) and `slug` (product); a
  row with no material difference is recorded as `NO_CHANGE` and counted as
  _skipped_. Re-importing the identical file is a no-op.
- **Update identifiers** (documented, stable):
  - variant → `sku` (the upsert key; a SKU cannot move between products);
  - product → `product_slug` if present, otherwise a slug derived from
    `product_name`.
- **Caps:** `IMPORT_MAX_FILE_SIZE_BYTES` (default 5 MB) and
  `IMPORT_MAX_ROW_COUNT` (default 10 000), enforced before parsing.
- **XLSX** is out of scope for Phase 4. The `SourceFormat` seam in
  `csv-parser.ts` and the format-agnostic `ImportJob.sourceFormat` mean an
  `exceljs`-backed reader can be added later without touching the pipeline.

### CSV columns (Phase 4)

Template: [`docs/product-import-template.csv`](product-import-template.csv) —
also downloadable at `GET /api/admin/import/products/template`.

| Column                                                              | Required | Notes                                                                                  |
| ------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `sku`                                                               | ✅       | 3–64 chars, `[A-Za-z0-9][A-Za-z0-9._-]*`. Update key.                                  |
| `product_name`                                                      | ✅       | ≤ 200 chars                                                                            |
| `price`                                                             | ✅       | CAD dollars (`39.99`); stored as integer cents; must be > 0                            |
| `product_slug`                                                      | —        | Stable product key; derived from name if blank                                         |
| `description`                                                       | —        | Plain text                                                                             |
| `brand`                                                             | —        | Brand name; created if missing                                                         |
| `category`                                                          | —        | Category name; created if missing                                                      |
| `status`                                                            | —        | `draft` (default) / `active` / `archived`                                              |
| `compare_at_price`                                                  | —        | CAD dollars; must exceed `price`                                                       |
| `cost_price`                                                        | —        | CAD dollars                                                                            |
| `barcode`                                                           | —        | 4–64 chars; unique                                                                     |
| `weight_grams`                                                      | —        | integer ≥ 0                                                                            |
| `inventory_quantity`                                                | —        | integer ≥ 0; sets on-hand (writes a stock movement)                                    |
| `option1_name` / `option1_value` … `option3_name` / `option3_value` | —        | Up to 3 option pairs; both of a pair required together; **not** limited to Size/Colour |
| `image_url`                                                         | —        | absolute `https://` URL                                                                |

The normalised option model means new option types (Material, Age Group, Style,
…) work with no schema or code change — just new `optionN_*` values in the file.

## 10. AuditLog actions added in Phase 4

Dotted `domain.subject.event` strings (`src/server/audit/actions.ts`):

`catalog.brand.created|updated|archived`,
`catalog.category.created|updated|archived`,
`catalog.product.created|updated|status_changed|options_changed`,
`catalog.variant.created|updated|price_changed|archived`,
`catalog.image.added|updated|removed`,
`inventory.adjusted|received|reserved|released|committed|restocked`,
`import.product.previewed|committed|cancelled`.

Metadata is sanitised by `recordAudit` (Phase 3) and never contains secrets,
credentials, or tokens.

## 11. Migration workflow

Unchanged from Phase 2 (`npm run db:migrate` / `db:deploy` / `db:seed`). The
Phase 4 migration `20260905000000_phase4_catalog` was generated offline
(`prisma migrate diff`) and verified deterministic; it applies on top of the
Phase 2 + Phase 3 migrations.

## 12. Live database verification status

**Resolved.** The Phase 5 pre-flight (2026-09-03) ran `prisma migrate deploy`,
seeding, and DB-backed verification of catalogue CRUD, variant constraints,
inventory transactions, and the import preview→commit→re-import round trip
against the local docker-compose PostgreSQL.

Phase 5 adds a standing database-backed suite (`npm run test:integration`,
`tests/integration/`): inventory transaction semantics, concurrency (no
oversell under parallel reservations), the ledger invariant, and the
order→inventory lifecycle. Run `docker compose up -d && npm run db:deploy`
first.
