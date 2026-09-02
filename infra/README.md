# Infrastructure (`infra/`)

Deployment and operational assets. Kept separate from application code.

## Current (Phase 1)

- **`../docker-compose.yml`** — local development PostgreSQL only. Run from the
  repo root with `docker compose up -d`. Requires `POSTGRES_PASSWORD` in `.env`.

## Planned

- `Dockerfile` — multi-stage production image built on Next.js `output: "standalone"`.
- CI workflow (install → format:check → lint → typecheck → test → build → e2e).
- Database migration job definition.
- Object-storage bucket / CDN configuration notes.

See `docs/architecture.md` § Deployment architecture.
