# Product import (`src/server/import`)

CSV product import (Phase 4). Full workflow + guarantees in `docs/catalog.md`
§ "Product import workflow (CSV)".

| File                        | Responsibility                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `cell-sanitize.ts`          | Formula/spreadsheet-injection defence (neutralise on read, escape on write)                                  |
| `csv-parser.ts`             | `parseCsv` (via `csv-parse`) with size/row caps, UTF-8 check, header normalisation                           |
| `row-source.ts`             | `RowSource` registry — maps an upload to a parser that yields a `ParsedTable`. CSV ships; XLSX plugs in here |
| `product-import-columns.ts` | Column contract + downloadable template                                                                      |
| `product-import-schema.ts`  | `parseProductRow` — normalisation + business validation, collecting all `RowError`s                          |
| `product-import-service.ts` | `previewImport` (dry-run, no writes) + `commitImport` (per-row transaction, upsert by SKU) + `cancelImport`  |
| `errors.ts`                 | `ImportFileError` (aborts file) + `RowError` shape                                                           |

**Update keys:** variant → `sku`; product → `product_slug` (or derived from
`product_name`). **Idempotent:** re-importing the same file is a no-op; on
update, only fields present in the row change (blank cell = leave as-is).

**Images:** `image_url` → product-level `ProductImage`; `variant_image_url` →
`ProductImage` bound to that row's variant. Both are https references only —
nothing is downloaded. Hosted uploads go through the admin image UI.

**Formats:** CSV today. To add XLSX, register a `RowSource` in `row-source.ts`
whose `parse` yields the same `ParsedTable` — no other file changes. A `.xlsx`
upload currently returns a clear "export as CSV" message.
