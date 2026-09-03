# Taek Shops — Product Import Specification

> Status: **Full future specification.** Defines the eventual CSV/XLSX importer
> (column mapping, 22 columns, XLSX, image fetching, etc.).
>
> **Phase 4 shipped a CSV foundation** — a documented subset of this: CSV only,
> ~20 columns using an `option1/2/3` pattern, no column-mapping UI, external
> `image_url` references only. As-built behaviour and the Phase 4 column set are
> in [`docs/catalog.md`](catalog.md) § "Product import workflow (CSV)"; the
> template is `docs/product-import-template.csv`. The remaining items below
> (XLSX, heading mapping, in-file image download, the full column set) are later
> phases. The pipeline was built format-agnostic so they slot in without a
> redesign.

## 1. Purpose & scope

Let an authorised staff/admin user bulk-create and bulk-update the catalogue
(products, variants, SKUs, prices, stock, categories, image references) by
uploading a spreadsheet.

Each **row = one product variant** (one buyable SKU). Product-level fields are
repeated on every variant row of that product and must be consistent across rows
sharing a `product_name` + `category`.

## 2. Supported files

| Property      | Rule                                                                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formats       | `.csv` (UTF-8, comma-delimited) and `.xlsx` (first sheet, or a sheet named `products`)                                                              |
| Max file size | `IMPORT_MAX_FILE_SIZE_BYTES` (default 5 MB) — configurable, not hard-coded                                                                          |
| Max data rows | `IMPORT_MAX_ROW_COUNT` (default 10 000) — configurable                                                                                              |
| Encoding      | UTF-8 (with or without BOM). Other encodings are rejected with a clear message                                                                      |
| Header row    | Row 1, required. Column order does not matter. Unknown columns are ignored (reported).                                                              |
| XLSX safety   | Macro-enabled workbooks (`.xlsm`) rejected. Formulas are never evaluated; a cell containing a formula is read as its last cached value and flagged. |

## 3. Column dictionary

**Required** columns must be present in the header **and** non-empty for every
row (unless a per-field exception is noted). **Optional** columns may be absent;
if absent, the documented default applies.

| Column                 | Req?     | Type / format                                                                                                         | Rules & notes                                                                                                                        | Example                                                                                                                                                   |
| ---------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sku`                  | Required | String, 3–64 chars, `[A-Za-z0-9._-]`                                                                                  | **Unique identifier.** Case-insensitive uniqueness, stored uppercase. Must be unique within the file and is the upsert key.          | `UNI-STU-WHT-140`                                                                                                                                         |
| `product_name`         | Required | String, 1–200 chars                                                                                                   | Groups variants into a product together with `category`. Must be identical across a product's rows.                                  | `Student Taekwondo Uniform`                                                                                                                               |
| `description`          | Optional | String, ≤ 5 000 chars, plain text or limited Markdown                                                                 | Product-level. First non-empty value per product wins; conflicting values are a **warning**.                                         | `Lightweight poly-cotton dobok.`                                                                                                                          |
| `category`             | Required | String; must match an existing Category name **or** slug (case-insensitive)                                           | Part of the product identity. Auto-create disabled by default (config `IMPORT_ALLOW_CATEGORY_CREATE`).                               | `Uniforms`                                                                                                                                                |
| `subcategory`          | Optional | String; existing child Category of `category`                                                                         | If given and not found → row error (unless category creation enabled).                                                               | `Student Uniforms`                                                                                                                                        |
| `brand`                | Optional | String; existing Brand name/slug                                                                                      | Unknown brand → row error unless `IMPORT_ALLOW_BRAND_CREATE`. Empty → product has no brand.                                          | `Taek Basics`                                                                                                                                             |
| `product_type`         | Required | Enum: `uniform`, `belt`, `sparring_gear`, `protective_gear`, `training_equipment`, `accessory`, `apparel`, `footwear` | Drives which attribute columns are expected. Unknown value → row error.                                                              | `uniform`                                                                                                                                                 |
| `variant_name`         | Optional | String, ≤ 200 chars                                                                                                   | Human label for the variant. If empty, derived from non-empty attributes (e.g. `White / Size 3`).                                    | `White / 140 cm`                                                                                                                                          |
| `size`                 | Cond.    | String, ≤ 40 chars (free text; validated against known size lists per type)                                           | Required when `product_type ∈ {uniform, belt, sparring_gear, protective_gear, apparel, footwear}`.                                   | `140` / `3` / `M`                                                                                                                                         |
| `colour`               | Cond.    | String, ≤ 40 chars                                                                                                    | Required for `apparel`, `uniform` (top/pants sets), `sparring_gear` where colour varies. Canonicalised (`grey`→`gray` configurable). | `White`                                                                                                                                                   |
| `gender`               | Optional | Enum: `mens`, `womens`, `unisex`, `youth`                                                                             | Default `unisex`. Invalid value → row error.                                                                                         | `unisex`                                                                                                                                                  |
| `age_group`            | Optional | Enum: `adult`, `youth`, `child`                                                                                       | Default `adult`. Invalid value → row error.                                                                                          | `adult`                                                                                                                                                   |
| `cost_price_cad`       | Optional | Decimal, CAD, ≥ 0, ≤ 2 decimal places                                                                                 | Internal cost (margin reports). Never shown on storefront. Stored as integer cents.                                                  | `18.50`                                                                                                                                                   |
| `sale_price_cad`       | Required | Decimal, CAD, > 0, ≤ 2 decimal places, ≤ 100 000                                                                      | The selling price. Stored as integer cents. Comma decimal separators rejected (`18,50` → error).                                     | `39.99`                                                                                                                                                   |
| `compare_at_price_cad` | Optional | Decimal, CAD, ≥ 0, ≤ 2 decimal places                                                                                 | Display "was" price. Must be **>** `sale_price_cad` if set, else **warning** and field ignored.                                      | `49.99`                                                                                                                                                   |
| `tax_category`         | Optional | Enum: `standard`, `zero_rated`, `exempt`, `childrens_clothing`, `footwear`                                            | Default `standard`. The platform ships **no tax rates**; this only classifies the item. Unknown → error.                             | `standard`                                                                                                                                                |
| `stock_quantity`       | Required | Integer, ≥ 0, ≤ 1 000 000                                                                                             | Interpreted per `stock_mode` (see §5). Decimals/negatives → row error.                                                               | `120`                                                                                                                                                     |
| `low_stock_threshold`  | Optional | Integer, ≥ 0                                                                                                          | Default from config (`IMPORT_DEFAULT_LOW_STOCK_THRESHOLD`, default 5). Alert only; never blocks sales.                               | `10`                                                                                                                                                      |
| `weight_grams`         | Cond.    | Integer, > 0, ≤ 100 000                                                                                               | Required when shipping is weight-based (config `IMPORT_REQUIRE_WEIGHT`, default true). Feeds parcel weight.                          | `600`                                                                                                                                                     |
| `barcode`              | Optional | String, 8–14 digits (EAN/UPC) or ≤ 32 chars free code                                                                 | If present, must be unique across variants. Checksum validated for 12/13-digit codes (warning if bad).                               | `06251234567890`                                                                                                                                          |
| `image_url`            | Optional | Absolute `https://` URL, or `                                                                                         | `-separated list                                                                                                                     | Host must be on `IMPORT_IMAGE_URL_ALLOWLIST`. Fetched server-side, size/content-type checked, re-stored in our bucket. First = primary. Never linked hot. | `https://cdn.example.com/uni-white.jpg` |
| `active`               | Optional | Boolean: `true`/`false`/`1`/`0`/`yes`/`no` (case-insensitive)                                                         | Default `true`. Controls storefront visibility of the **variant**. A product with no active variant is hidden.                       | `true`                                                                                                                                                    |

### Column status summary

- **Always required:** `sku`, `product_name`, `category`, `product_type`,
  `sale_price_cad`, `stock_quantity`.
- **Conditionally required:** `size`, `colour`, `weight_grams` (see rules above).
- **Optional:** `description`, `subcategory`, `brand`, `variant_name`, `gender`,
  `age_group`, `cost_price_cad`, `compare_at_price_cad`, `tax_category`,
  `low_stock_threshold`, `barcode`, `image_url`, `active`.

## 4. Unique identifiers & row grouping

| Concern                     | Key                                                                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Variant identity (upsert)   | `sku` (case-insensitive, stored uppercase)                                                                                                           |
| Product identity            | (`product_name` normalised) + resolved `category`                                                                                                    |
| Barcode uniqueness          | `barcode` across all variants (if provided)                                                                                                          |
| In-file duplicate detection | Duplicate `sku` in the same file → **error on the later row(s)**; the first occurrence is processed. Optionally (config) the whole file is rejected. |

Cross-file/DB duplicates are resolved by mode (§5).

## 5. Import modes & update behaviour

Selected in the UI before commit.

| Mode          | SKU exists in DB               | SKU new             |
| ------------- | ------------------------------ | ------------------- |
| `create_only` | **Skip** (reported as skipped) | Create              |
| `update_only` | Update changed fields          | **Skip** (reported) |
| `upsert`      | Update changed fields          | Create              |

**Field-level update rules (in `update_only` / `upsert`):**

- Only columns **present in the file** are considered. An **absent column** never
  changes existing data. An **empty cell** in a present optional column means
  "clear to default/null" only for a documented allow-list
  (`variant_name`, `compare_at_price_cad`, `barcode`, `brand`); for all other
  fields an empty cell in a present column is a **row error** (prevents
  accidental wipes).
- `sku` itself is never updated (it is the key).
- **Price changes** (`sale_price_cad`, `compare_at_price_cad`, `cost_price_cad`):
  applied via `PricingService`. A change exceeding
  `IMPORT_PRICE_CHANGE_WARN_PCT` (default ±50%) is allowed but flagged in the
  preview for explicit confirmation.
- **Stock changes** (`stock_quantity`): behaviour set by `stock_mode`:
  - `set` (default) — set `onHand` to the value; writes a `StockMovement`
    (`type=import`, delta = new − current, `reason="import <batchId>"`).
  - `increment` — add the value to `onHand`.
  - Reserved quantity is never touched by import.
- **Category / brand reassignment** is applied but flagged in the preview
  (it moves the product in the storefront).
- `product_name` / `description` conflicts between rows of the same product →
  warning; first non-empty value wins.

## 6. Validation pipeline

1. **File checks** — format, size, row count, encoding, sheet presence, macro
   check. Failure here rejects the whole file with one message.
2. **Header checks** — required columns present; unknown columns listed as
   warnings; duplicate headers → error.
3. **Column mapping** — auto-map by normalised heading (lowercase, spaces/hyphens
   → `_`, known synonyms e.g. `price`→`sale_price_cad`, `qty`→`stock_quantity`).
   Unmapped required columns block the import until the user maps them in the UI.
4. **Row validation** — for every row, run the Zod schema and cross-field rules;
   **collect all errors for the row** (do not stop at the first).
5. **Cross-row validation** — in-file duplicate `sku` / `barcode`, product-field
   consistency.
6. **Referential validation** — resolve `category`, `subcategory`, `brand`
   against the DB.
7. **Preview build** — classify each row as `create` / `update` / `skip` /
   `error`, with a per-field diff for updates.

Nothing is written to the catalogue before step 7 is confirmed by the user.

## 7. Preview & commit

- **Preview** shows: total rows, and counts for create / update / skip / error;
  the list of warnings; a paginated per-row table with the planned action and
  diff; and the count of price/stock changes needing confirmation.
- **Commit** processes only non-error rows, in **chunked transactions**
  (default 200 rows per transaction, configurable):
  - Each chunk is atomic — a failure rolls back that chunk only; already-committed
    chunks stand.
  - A single failing row inside a chunk is caught, the row is marked `failed`
    with its error, and the rest of the chunk proceeds (the row's own writes are
    rolled back via a savepoint).
  - Price/stock mutations go through the domain services so `StockMovement` and
    `AuditLog` entries are written in the same transaction as the change.
- **Progress** is reported to the UI (rows processed / total, current chunk).
- **Idempotency:** re-running the identical file in `upsert` mode results in
  0 creates, 0 net changes (updates that change nothing are reported as
  `no_change`).

## 8. Result summary & audit

On completion the importer records:

- **`ImportBatch`**: id, actor, filename, file hash, storage key, mode,
  `stock_mode`, column mapping, started/finished timestamps, duration, and
  totals (`created`, `updated`, `skipped`, `no_change`, `failed`).
- **`ImportRow`** (one per input row): row number, `sku`, resolved action,
  status (`created|updated|skipped|no_change|failed`), and the list of
  errors/warnings.
- **Downloadable error report** — a CSV of every `failed`/`error` row with the
  original data plus an `errors` column, so the operator can fix and re-upload
  just those rows.
- Batches are listed in the admin UI (`/admin/imports`) with drill-down.

## 9. Error handling & reporting

- **Error object shape:** `{ row: number, column: string | null, code: string,
message: string, value: string | null }`.
- **Codes (initial set):** `file_too_large`, `too_many_rows`, `bad_encoding`,
  `missing_required_column`, `duplicate_header`, `unmapped_required_column`,
  `missing_required_value`, `invalid_enum`, `invalid_number`, `invalid_integer`,
  `negative_value`, `too_many_decimals`, `invalid_url`, `url_host_not_allowed`,
  `invalid_boolean`, `duplicate_sku_in_file`, `duplicate_barcode`,
  `unknown_category`, `unknown_brand`, `compare_at_not_greater`,
  `product_field_conflict`, `empty_cell_not_allowed`, `image_fetch_failed`.
- **Severity:** `error` (row not written) vs `warning` (row written, noted).
- **Never**: silently coerce a bad price or quantity, partially import a row,
  swallow an exception, or leave the DB in a state not reflected in the summary.
- **Formula / CSV injection:** any cell whose trimmed value starts with
  `=`, `+`, `-`, `@`, or a control character (tab/CR/LF, `0x00`–`0x1F`) is
  treated as text; if it also parses as a needed value it is accepted as the
  literal text, otherwise it is an `error`. Template exports prefix such values
  with `'`. Uploaded formulas are logged.
- **Malicious file protection:** strict extension + MIME allow-list, size/row
  caps, streamed parsing (bounded memory), no external entity / zip-bomb
  expansion for XLSX (decompressed-size cap), stored outside the web root,
  scanned filename, admin-role gate, per-user rate limit, full audit trail.

## 10. Downloadable template

`GET /admin/imports/template?format=csv|xlsx` (admin only) returns a file with:

- The header row containing every column in the dictionary order above.
- 2–3 **synthetic** example rows (no real product or supplier data).
- For XLSX: a second `instructions` sheet summarising required columns, enums,
  and formats; data cells formatted as text to discourage Excel auto-conversion
  (e.g. stripping leading zeros from `barcode`).

### Example rows (CSV)

```csv
sku,product_name,description,category,subcategory,brand,product_type,variant_name,size,colour,gender,age_group,cost_price_cad,sale_price_cad,compare_at_price_cad,tax_category,stock_quantity,low_stock_threshold,weight_grams,barcode,image_url,active
UNI-STU-WHT-140,Student Taekwondo Uniform,Lightweight poly-cotton dobok for beginners.,Uniforms,Student Uniforms,Taek Basics,uniform,White / 140 cm,140,White,unisex,youth,18.50,39.99,49.99,standard,120,10,600,,https://cdn.example.com/img/uni-stu-wht.jpg,true
UNI-STU-WHT-160,Student Taekwondo Uniform,Lightweight poly-cotton dobok for beginners.,Uniforms,Student Uniforms,Taek Basics,uniform,White / 160 cm,160,White,unisex,adult,19.50,42.99,,standard,80,10,680,,https://cdn.example.com/img/uni-stu-wht.jpg,true
BLT-WKF-BLK-4,Competition Black Belt,Cotton competition belt with silk stitching.,Belts,,Taek Basics,belt,Black / 4,4,Black,unisex,adult,7.00,17.99,,standard,45,5,180,,,true
```

## 11. Configuration keys (all with safe defaults, none secret)

| Key                                  | Default   | Meaning                                         |
| ------------------------------------ | --------- | ----------------------------------------------- |
| `IMPORT_MAX_FILE_SIZE_BYTES`         | 5 000 000 | Reject larger uploads                           |
| `IMPORT_MAX_ROW_COUNT`               | 10 000    | Reject files with more data rows                |
| `IMPORT_CHUNK_SIZE`                  | 200       | Rows per commit transaction                     |
| `IMPORT_DEFAULT_LOW_STOCK_THRESHOLD` | 5         | Used when `low_stock_threshold` absent          |
| `IMPORT_PRICE_CHANGE_WARN_PCT`       | 50        | Flag price moves beyond ±this percent           |
| `IMPORT_REQUIRE_WEIGHT`              | true      | Make `weight_grams` required                    |
| `IMPORT_ALLOW_CATEGORY_CREATE`       | false     | Allow importer to create missing categories     |
| `IMPORT_ALLOW_BRAND_CREATE`          | false     | Allow importer to create missing brands         |
| `IMPORT_IMAGE_URL_ALLOWLIST`         | (empty)   | Comma-separated hosts permitted for `image_url` |

## 12. Open questions for CTO

1. Confirm the `product_type` enumeration and the per-type required-attribute
   matrix (§3 `size`/`colour` conditions).
2. Confirm the `tax_category` value list — this classifies items only; actual
   Canadian rate rules are configured separately and are not in scope here.
3. Default `stock_mode` (`set` vs `increment`) for the common re-stock workflow.
4. Whether an in-file duplicate `sku` should fail just the row or the whole file.
5. Whether category/brand auto-creation should be allowed for the owner's
   first bulk load.
