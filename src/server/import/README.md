# Product import (`src/server/import`)

CSV product import (Phase 4). Full workflow + guarantees in `docs/catalog.md`
§ "Product import workflow (CSV)".

| File                        | Responsibility                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `cell-sanitize.ts`          | Formula/spreadsheet-injection defence (neutralise on read, escape on write)                                          |
| `csv-parser.ts`             | `parse` (via `csv-parse`) with size/row caps, UTF-8 check, header normalisation, `SourceFormat` seam for future XLSX |
| `product-import-columns.ts` | Column contract + downloadable template                                                                              |
| `product-import-schema.ts`  | `parseProductRow` — normalisation + business validation, collecting all `RowError`s                                  |
| `product-import-service.ts` | `previewImport` (dry-run, no writes) + `commitImport` (per-row transaction, upsert by SKU) + `cancelImport`          |
| `errors.ts`                 | `ImportFileError` (aborts file) + `RowError` shape                                                                   |

**Update keys:** variant → `sku`; product → `product_slug` (or derived from
`product_name`). **Idempotent:** re-importing the same file is a no-op.
XLSX support is deferred; the pipeline is format-agnostic.
