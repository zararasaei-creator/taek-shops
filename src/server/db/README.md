# Database access (`src/server/db`)

All PostgreSQL access goes through this module. Nothing outside `src/server`
imports a database client directly.

**Planned contents (Phase 2+):**

- `client.ts` — singleton Prisma client (guarded against hot-reload duplication).
- `../../../prisma/schema.prisma` — schema of record.
- Repository / query helpers grouped by aggregate (products, inventory, orders).

Not implemented in Phase 1. See `docs/architecture.md` and
`docs/implementation-roadmap.md`.
