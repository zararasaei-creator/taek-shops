# Object storage (`src/server/storage`)

Provider-agnostic storage for product images (and later, other assets). Binary
data never touches PostgreSQL — only a reference (`ProductImage.url`).

| File                      | Responsibility                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `object-storage.ts`       | `ObjectStorage` interface + image-type / key-safety / key-generation helpers              |
| `local-object-storage.ts` | Dev/test backend on the local filesystem (`./storage/objects`, git-ignored)                |
| `s3-object-storage.ts`    | S3-compatible backend (real S3 or local MinIO) — presigned uploads, path-style addressing  |
| `image-sniff.ts`          | Byte-level (magic-number) image format detection — never trusts a claimed content-type     |
| `upload-cleanup.ts`       | Sweeps abandoned staged uploads (see below); relative-import-only for the CLI script       |
| `index.ts`                | `getObjectStorage()` — selects S3-compatible when `S3_*` is configured, else local         |

`GET /api/media/[...key]` serves the local backend in dev. In production with a
real CDN, images are served directly from the bucket URL and that route is
unused.

## Local MinIO (Phase 9)

`docker compose up -d` also starts a local, S3-compatible MinIO service (see
`docker-compose.yml`) and a one-shot `minio-init` container that creates the
configured bucket. Generate your own **local-only** dev credentials for
`S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` in `.env` (see `.env.example`) —
never real cloud credentials, and never commit real values. Leave all six
`S3_*` variables blank to use the local-filesystem backend instead (no Docker
required).

A local MinIO URL (`http://localhost:9000/...`) is a **development
convenience only — it is NOT a production CDN**. A real deployment sets
`S3_PUBLIC_BASE_URL` to that CDN's own URL; `next.config.ts`'s
`images.remotePatterns` is derived from exactly that one configured URL, never
a wildcard host.

## Upload flow (Phase 9)

Two paths, both ending at the same `image-service.ts#addProductImage`:

- **S3-compatible backend** (real S3 / local MinIO): the browser uploads
  directly to storage via a short-lived presigned URL
  (`createProductImageUploadSlot`), bypassing the app server for the bytes.
  Because the server never sees those bytes in transit, they're staged under
  a `staging/` key — tracked by a `ProductImageUpload` row, never exposed to
  the storefront or admin image list (`listProductImages` only ever reads
  `ProductImage`) — until `finalizeProductImageUpload` fetches them back and
  verifies the **actual bytes** (`image-sniff.ts`; the claimed content-type
  is never trusted) before creating the real `ProductImage` row.
- **Local filesystem backend** (`createSignedUpload` returns `null`, no
  direct-upload support): `uploadProductImage` — one synchronous request,
  same byte-level validation, no staging.

An upload slot that's created but never finalized (closed tab, crashed
browser, network failure) is cleaned up by `upload-cleanup.ts`'s
`sweepAbandonedImageUploads` — run via `npm run images:cleanup-uploads`
(`scripts/cleanup-image-uploads.ts`), a bounded, one-pass sweep of rows older
than 24h. In a real deployment this should run on a schedule, same as
`npm run emails:dispatch` — see the roadmap for that outstanding production
requirement.

**Remaining integration:** production deployment scheduling for the cleanup
script; variant-specific image display on the storefront (product-level
images — `variantId: null` — are what the storefront shows today; per-variant
images exist in the data model but aren't yet swapped in by the variant
picker). See `docs/catalog.md` § "Product images — foundation".
