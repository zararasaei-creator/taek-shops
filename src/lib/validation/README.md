# Shared validation schemas (`src/lib/validation`)

Zod schemas shared between client and server: form inputs, API request/response
shapes, and derived TypeScript types. Server-only schemas (e.g. import row
schema) live under `src/server/import` instead.

Not populated in Phase 1 beyond this note. The environment schema is a special
case and lives in `src/server/config/env.ts`.
