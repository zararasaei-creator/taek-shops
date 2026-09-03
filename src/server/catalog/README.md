# Catalogue (`src/server/catalog`)

Product / brand / category / variant / option / image administration. See
`docs/catalog.md` for the full design.

| File                  | Responsibility                                                               |
| --------------------- | ---------------------------------------------------------------------------- |
| `slug.ts`             | Slug generation + validation                                                 |
| `option-signature.ts` | Deterministic variant option signature (DB-level dup prevention)             |
| `errors.ts`           | Typed `CatalogError`s (code + status + safe message)                         |
| `brand-service.ts`    | Brand CRUD + referential-integrity guard                                     |
| `category-service.ts` | Category CRUD + tree/cycle validation                                        |
| `product-service.ts`  | Product CRUD + lifecycle (`DRAFT/ACTIVE/ARCHIVED`)                           |
| `option-service.ts`   | Options/values; `ensureOptionValueTx` for the importer                       |
| `variant-service.ts`  | Variants; SKU/signature/option-coverage invariants; `createVariantTx`        |
| `image-service.ts`    | `ProductImage` foundation; storage-backed or external URLs                   |
| `catalog-queries.ts`  | Public storefront reads (status-filtered; no auth check)                     |
| `tx.ts`               | Shared `CatalogTxClient` type                                                |
| `index.ts`            | Barrel (`brands`, `categories`, `products`, `variants`, `options`, `images`) |

**Rules:** every mutating function calls `requirePermission(actor, "catalog.write")`
(or `inventory.write`) first, validates with Zod, uses `$transaction` for
multi-write operations, and writes an `AuditLog` entry.
