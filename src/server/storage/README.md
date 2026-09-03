# Object storage (`src/server/storage`)

Provider-agnostic storage for product images (and later, other assets). Binary
data never touches PostgreSQL — only a reference (`ProductImage.url`).

| File                      | Responsibility                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `object-storage.ts`       | `ObjectStorage` interface + image-type / key-safety helpers                        |
| `local-object-storage.ts` | Dev/test backend on the local filesystem (`./storage/objects`, git-ignored)        |
| `index.ts`                | `getObjectStorage()` — selects S3-compatible when `S3_*` is configured, else local |

`GET /api/media/[...key]` serves the local backend in dev. In production with a
real CDN, images are served directly from the bucket URL and that route is
unused.

**Remaining integration:** the S3-compatible `ObjectStorage` implementation,
signed direct-upload wiring, and the admin upload UI. Interface + dev backend +
data model are in place. See `docs/catalog.md` § "Product images — foundation".
