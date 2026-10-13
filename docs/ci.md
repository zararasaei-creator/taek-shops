# Pre-release verification (CI)

Host-neutral. All pipeline logic lives in one script that any host's job can run. A minimal,
**manual-only** GitHub Actions wrapper exists at `.github/workflows/verify.yml` (see
[Activation](#activation)); it adds no pipeline logic of its own:

```bash
bash scripts/ci/verify.sh        # exits non-zero on the first failing step
```

It verifies; it does **not** deploy, publish an image, run a scheduler, or use any real secret.

## What it runs (in order)

| Step | Command it reuses | Notes |
| --- | --- | --- |
| install | `npm ci` | Lockfile only. Node **24** (`.nvmrc`; same as the production image). |
| typecheck, lint, unit | `npm run typecheck`, `npm run lint`, `npm test` | No database. |
| disposable services | `ci/docker-compose.ci.yml` | PostgreSQL 17 (tmpfs) + MinIO (built from pinned official source, `ci/minio/Dockerfile`), ephemeral loopback ports, per-run synthetic credentials, unique compose project; torn down with `down -v --rmi local`. |
| migrations | `prisma migrate deploy` | Against the disposable **test** database only (`DATABASE_URL` is overridden for that one command). |
| integration | `npm run test:integration` equivalent | Existing isolation guard stays on (distinct DB names, live check). The script then **fails if the real-MinIO suite was skipped** (that suite skips silently when unconfigured). |
| e2e | `npx playwright test` | Existing config: `PAYMENT_GATEWAY=e2e-fake`, `EMAIL_TRANSPORT=local-preview`, S3 blanked, own port/DB. Its `npm run build && npm run start` is also the application-build gate, so there is no separate `npm run build`. |
| image | `docker build` (runner) and `docker build --target migrate` | Synthetic public build args. |
| image smoke | migrate image on a fresh DB, then boot runner, poll `/api/health` | Proves the migration target and that the image starts; the full job/CLI smoke test in `docs/deployment.md` §6 stays manual. |

Safeguards in the script: refuses to run if a `.env` file exists (a developer's `.env` would
silently fill unset variables, e.g. a real database URL); refuses a non-loopback database/S3
target; unsets any inherited provider or test-bypass variable (`RESEND_API_KEY`, `EMAIL_TRANSPORT`,
`PAYMENT_GATEWAY`, `E2E_DIST_DIR`, …); never contacts a dev or production database.
Existing test guards and rate limits are untouched (the e2e specs keep their per-run IP headers).

Flags (`--skip-install`, `--skip-e2e`, `--skip-image`) exist for local iteration only; a release
gate runs with none.

## Not gated (known)

- **`npm run format:check` is not in the pipeline.** It currently fails on 83 existing files
  (pre-existing, unrelated); gating it needs a one-off reformat commit first.
- Dependency audit, security-header scan, load tests, and deployment/rollback are other Phase 13 items.
- **MinIO is built from source in CI.** MinIO no longer publishes community images (`quay.io/minio/*`
  refuses anonymous pulls, `dl.min.io` binaries are gone). `ci/minio/Dockerfile` builds the server and
  `mc` from the official source at pinned tags, on digest-pinned official base images; `verify.sh`
  builds it first (about 4 extra minutes on the hosted runner). The upstream project is archived, so this is for a
  disposable loopback test server with synthetic credentials only. The dev `docker-compose.yml` still
  references the withdrawn images (they work only from the local cache).

## Activation

1. Choose/confirm the CI host (none can be inferred: no remote, no `repository` field).
2. Create a minimal-permission job on it that: checks out the repo, installs **Node 24** (`.nvmrc`)
   and Docker with Compose v2, then runs `CI_PLAYWRIGHT_DEPS=1 bash scripts/ci/verify.sh`
   (`CI_PLAYWRIGHT_DEPS=1` installs Chromium's OS packages on a bare Linux runner).
   Give it read-only repository access and **no secrets** — none are needed.
3. Add timeouts at the job level (the script already bounds each step) and, on failure only, upload
   `test-results/` and `playwright-report/`. **Never** upload `.local/` (email previews), `.env*`,
   database dumps, or `.e2e-storage-objects/`.
4. Do not give this job registry-push or deploy credentials; image publishing is a separate,
   later, explicitly authorised job.

## Verified vs. not verified

See the "CI verification" entry in `docs/implementation-roadmap.md` (Phase 13): the script was
exercised locally on a clean copy of the repository. The GitHub workflow was validated locally
(YAML parse and structural checks only). **Hosted run #1 (2026-10-13) failed:** typecheck, lint and
the 524 unit tests passed on the hosted runner; starting the services failed on the withdrawn MinIO
image; integration, e2e and the application/image builds were not executed. **Hosted run #2
(2026-10-13, after the MinIO fix) passed end to end** — 524 unit, 290 integration (real MinIO: 10, 0
skipped), 40 e2e, both image builds and the image smoke — in about 11 minutes. See the roadmap entry
"First hosted CI run and the MinIO image blocker". **Hosted results are recorded in the roadmap and
are separate from the earlier local evidence.** The workflow is `workflow_dispatch` only
(no push/PR trigger), has `contents: read`, no secrets, no artifacts, a 45-minute job timeout, and a
concurrency group that queues rather than cancels. It runs on the repository owner's included
GitHub Actions allowance; the account has no payment method, so usage is blocked, not billed, if
the allowance is exhausted (GitHub billing documentation).
