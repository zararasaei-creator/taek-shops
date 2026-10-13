# Infrastructure (`infra/`)

Deployment and operational assets. Kept separate from application code.

## Current (Phase 1)

- **`../docker-compose.yml`** — local development PostgreSQL only. Run from the
  repo root with `docker compose up -d`. Requires `POSTGRES_PASSWORD` in `.env`.

## Phase 13 (production runtime)

- **`../Dockerfile`** + **`../.dockerignore`** — multi-stage production image (`next start`, non-root;
  default target runs the web app and the three jobs, `--target migrate` runs `prisma migrate deploy`).
  Runbook, environment checklist and smoke-test recipe: **`../docs/deployment.md`**.

- **`../scripts/ci/verify.sh`** + **`../ci/docker-compose.ci.yml`** — host-neutral pre-release verification
  (typecheck, lint, unit, integration on disposable Postgres + MinIO, e2e, image build). Runbook: **`../docs/ci.md`**.
  No hosted CI is configured yet (no git remote).

- **`../scripts/db/`** — manual PostgreSQL backup (`backup.sh`), restore into a new isolated database
  (`restore.sh`) and a synthetic-data restore drill (`restore-drill.sh`). Runbook: **`../docs/backup-restore.md`**.

- **`../docs/monitoring.md`** — structured log events, liveness vs readiness probes, and the alert rules a future host
  should implement (nothing is collected or alerted on yet).

## Planned

- Database migration job definition.
- Object-storage bucket / CDN configuration notes.

See `docs/architecture.md` § Deployment architecture.
