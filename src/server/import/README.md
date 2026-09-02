# Spreadsheet import processing (`src/server/import`)

The admin CSV/XLSX product import pipeline. Isolated here because it has distinct
security concerns (untrusted file parsing, formula injection, large payloads) and
a multi-step workflow (upload → parse → map → validate → preview → commit).

**Planned modules (import phase):**

- `parsing/` — CSV and XLSX readers with size/row caps and sanitisation.
- `schema.ts` — Zod row schema (see `docs/product-import-specification.md`).
- `mapping.ts` — column-heading mapping.
- `validation.ts` — row-level validation and error collection.
- `commit.ts` — transaction-safe upsert-by-SKU (create / update / skip modes).
- `audit.ts` — import history and audit log writes.

Not implemented in Phase 1. Full specification in
`docs/product-import-specification.md`.
