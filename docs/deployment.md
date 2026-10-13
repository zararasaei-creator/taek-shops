# Deployment runbook (production image)

Scope: build one container image, migrate the database as a **separate step**, run the web
app, and run the three existing jobs. This is host-agnostic — it names no hosting provider and
activates nothing. Nothing here has been run against a real environment; see
[Verified and not verified](#verified-and-not-verified).

## 1. The image

`Dockerfile` (repo root), Node 24 (`node:24-bookworm-slim`; `package.json` requires ≥ 22.18),
Next.js `next start` (not `output: "standalone"` — the jobs need `src/`, `scripts/` and `tsx`,
which a traced standalone bundle omits). Runs as a non-root user (uid 1001), `NODE_ENV=production`,
listens on `0.0.0.0:3000`, has a `/api/health` `HEALTHCHECK`. Put a TLS-terminating reverse proxy in
front of it. `.dockerignore` keeps `.env*`, `.local/` (email previews), local storage, backups/dumps,
`tests/`, `docs/`, `.git` and build output out of the build context.

Two targets: the default (`runner`: web + jobs) and `migrate` (Prisma CLI only).

**Three values are baked into the bundle at build time**, so build one image per environment (or per
set of these values): `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`,
`S3_PUBLIC_BASE_URL` (the `next/image` allow-list). They are public values — no secret is used at
build time and none is stored in a layer.

```bash
docker build -t taek-shops:<tag> \
  --build-arg NEXT_PUBLIC_APP_URL=https://<your-domain> \
  --build-arg NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=<pk_...> \
  --build-arg S3_PUBLIC_BASE_URL=https://<public-asset-base-url> .

docker build --target migrate -t taek-shops-migrate:<tag> .
```

## 2. Environment checklist (names only — values come from your secret store, never the image)

| Group | Names | Notes |
| --- | --- | --- |
| Application | `NEXT_PUBLIC_APP_URL` | Same value as the build arg. Must be a real non-localhost https URL for email links. |
| Database | `DATABASE_URL` | Runtime + `migrate`. For `migrate`, use a direct (non-pooled) connection. |
| Auth | `AUTH_SECRET` (≥ 16 chars; strongly recommended — keyed hashing of session/verification tokens), `AUTH_URL` (optional), `AUTH_ARGON_MEMORY_KIB` / `AUTH_ARGON_TIME_COST` / `AUTH_ARGON_PARALLELISM` (optional) | |
| Payment | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (build arg **and** runtime), `PAYMENT_CLAIMS_ACTIVE_SINCE` | Webhook endpoint: `POST /api/webhooks/stripe`. `PAYMENT_CLAIMS_ACTIVE_SINCE` fails closed when unset — see `docs/implementation-roadmap.md` "Establishing the rollout boundary". |
| Object storage | `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_BASE_URL` | All six, or the app silently falls back to a local-filesystem store that is **not** for production. `S3_PUBLIC_BASE_URL` is also a build arg. |
| Email | `EMAIL_TRANSPORT=resend`, `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS` | Production refuses every other transport. Requires a verified sending domain (owner task). |
| Optional tuning | `ORDER_EXPIRY_MINUTES`, `IMPORT_MAX_FILE_SIZE_BYTES`, `IMPORT_MAX_ROW_COUNT` | Safe defaults in code. |

**Never set in production** (test/dev switches; the app refuses most of them there, but do not rely on
that): `PAYMENT_GATEWAY`, `E2E_DIST_DIR`, `TEST_DATABASE_URL`, `LOCAL_STORAGE_ROOT`, `SEED_ADMIN_*`,
`POSTGRES_*`, any `EMAIL_TRANSPORT` other than `resend`.

## 3. Database migrations — a separate, explicit step

**Take a verified backup first** (`docs/backup-restore.md`) — a migration is the riskiest routine change to production data.

The web image **never** migrates or seeds on startup. Run this once per release, before starting the new
web containers, from the same environment/secret store:

```bash
docker run --rm -e DATABASE_URL taek-shops-migrate:<tag>          # prisma migrate deploy
docker run --rm -e DATABASE_URL taek-shops-migrate:<tag> migrate status   # optional check
```

Migrations are applied in order from `prisma/migrations/`. `prisma migrate deploy` does not seed and
does not reset. **Seeding is not part of deployment** (the seed also writes sample tax/shipping rows
and an optional admin from `SEED_ADMIN_*`). Create the first administrator with the bootstrap command below instead.

### First administrator (once, after migrating, before real use)

A migrated database has no users. Create the first ADMIN with the operator-only bootstrap command —
a **separate** step from migration, from web startup and from the dev seed (which writes sample
data and must not be run in production). It needs an **interactive terminal** (`-it`) because the
password is read from a hidden prompt (asked twice); there is no `--password` option, no
environment variable and no piping, and nothing secret is printed or logged:

```bash
docker run -it --rm --env-file <prod.env> taek-shops:<tag> \
  node_modules/.bin/tsx scripts/bootstrap-admin.ts --email <you@your-domain> [--first-name <n>] [--last-name <n>]
```

What it does: creates **one** ADMIN user — `ACTIVE` (so login works) but with the email **not** marked
verified — plus one `auth.admin.bootstrapped` audit row. It creates no products, tax rates, shipping
methods, orders or any other data, sends no email, and there is no HTTP endpoint for it. The password
must satisfy the app's existing password policy (≥ 10 characters, not common, not derived from your email
or name); it is refused otherwise (three attempts).

Safety: it **refuses** (exit code 2, nothing changed) if any ADMIN already exists, or if the email
already belongs to *any* account — it never promotes an existing user or overwrites a password. Two
simultaneous runs cannot both succeed (a database advisory lock serializes them; the unique email
constraint is a second backstop). Exit codes: `0` created, `2` refused/invalid input, `1` unexpected error.

**If the command finished but you lost the output** (or you are not sure it ran): re-running is
harmless — it prints `refused (admin_exists)` and changes nothing. Confirm with a read-only query:
`SELECT email, role, status FROM "User" WHERE role = 'ADMIN';`, then sign in at `/login`. If you do not
know the password, use **Forgot password** (this needs real email to be configured — an owner activation
task). Store the password in your secret manager at the moment you set it.

**Unresolved:** if the output is lost *and* sign-in and password reset are both unavailable, there is
**no supported recovery procedure**. The bootstrap command will not (and must not) take over an existing
account, and hand-editing or deleting the user row is deliberately **not** documented as a routine step.
Any such recovery would be operator-assisted, reviewed case by case, and is an open gap — not a feature of
this milestone.

## 4. Run the web app

```bash
docker run -d --name taek-shops --restart unless-stopped -p 3000:3000 --env-file <prod.env> taek-shops:<tag>
```

`--env-file` is a deployment-side file/secret injection (not in the repo or image). Health:
two probes (details and what to alert on: `docs/monitoring.md`): `GET /api/health` is **liveness** — `{"status":"ok","timestamp":…}`, process up, never touches the database, exposes no configuration (this is the
image's `HEALTHCHECK`); `GET /api/health/ready` is **readiness** — `200 {"status":"ready"}` when the database answers, `503 {"status":"unavailable"}` when it does not. Static files, TLS,
request-size limits and rate limiting at the edge belong to the reverse proxy.

## 5. Run the jobs

Same image, same env as the web app, one-shot containers. None schedules itself, and **no scheduler is
activated or provided here** — your platform's scheduler (cron, a scheduled-task feature, etc.) invokes
these. Suggested cadence only:

| Job | Command (`<img>` = `taek-shops:<tag>`) | Suggested cadence |
| --- | --- | --- |
| Email outbox dispatch | `docker run --rm --env-file <prod.env> <img> node scripts/dispatch-emails.ts` | every 1–5 min |
| Abandoned image-upload cleanup | `docker run --rm --env-file <prod.env> <img> node scripts/cleanup-image-uploads.ts` | hourly–daily |
| Abandoned-order reservation recovery | `docker run --rm --env-file <prod.env> <img> node_modules/.bin/tsx scripts/expire-abandoned-orders.ts` | every 15–60 min |

Each job writes structured JSON log lines to stdout/stderr — `job.started`, then `job.completed` (with a summary and `durationMs`) or
`job.failed` — and exits `0`; a crash exits `1`, and the order job also exits `1` when an order errored or
`PAYMENT_CLAIMS_ACTIVE_SINCE` is unset. No secret or customer data is logged. Event list, health probes and the
alert rules a host should implement (including detecting a job that never ran): **`docs/monitoring.md`**.
A `MODULE_TYPELESS_PACKAGE_JSON` warning from the two plain-`node` jobs is harmless. Run at most one
instance of each at a time unless you have read the concurrency notes in their source (all three are
written to be safe if two overlap, but this has not been load-tested).

## 6. Local smoke test (isolated, synthetic, no real providers)

This is what was run to verify the image — all names/keys synthetic, a throwaway Postgres on its own
Docker network, the web port published on a high loopback port (**not** 3000). Use obviously fake
values; never your real `.env`.

```bash
docker network create verify-net
docker run -d --name verify-pg --network verify-net --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_USER=verify -e POSTGRES_PASSWORD=<throwaway> -e POSTGRES_DB=verify postgres:17-alpine
# env file with synthetic: DATABASE_URL (to verify-pg), NEXT_PUBLIC_APP_URL=https://shop.example.test,
# STRIPE_* / RESEND_API_KEY = fake strings, EMAIL_TRANSPORT=resend, S3_* pointing at *.invalid, AUTH_SECRET
docker run --rm --network verify-net -e DATABASE_URL=<verify-pg url> taek-shops-migrate:verify
docker run -d --name verify-web --network verify-net --env-file verify.env -p 127.0.0.1:3199:3000 taek-shops:verify
curl http://127.0.0.1:3199/api/health
docker run --rm --network verify-net --env-file verify.env taek-shops:verify node scripts/dispatch-emails.ts
docker run --rm --network verify-net --env-file verify.env taek-shops:verify node scripts/cleanup-image-uploads.ts
docker run --rm --network verify-net --env-file verify.env taek-shops:verify node_modules/.bin/tsx scripts/expire-abandoned-orders.ts
docker rm -f verify-web verify-pg && docker network rm verify-net
```

Why `EMAIL_TRANSPORT=resend` with a fake key: production refuses `noop`/`local-preview` by design, so
the smoke test uses the real transport class with an empty outbox (no message is ever built or sent).
Do not create orders, registrations or other email-triggering data in a smoke test that uses it.

## 7. Platform requirements (what a host must provide)

Derived from the actual image, database use, storage code and jobs. Items marked *(untested)* are required by the
code's design but have not been exercised on a real host.

- **Container runtime.** Any OCI/Docker runtime that can run the `runner` image (Debian bookworm-slim, Node 24,
  non-root uid 1001; only `linux/amd64` was built and run). Listens on **TCP 3000**, HTTP only. Needs a writable
  `.next/cache` inside the container (no persistent volume is needed when S3 is configured). Memory and CPU:
  one short, light, synthetic local measurement (2026-10-13; roadmap, Phase 13 "Local resource measurement") saw a peak
  of **about 351 MiB** for the measured web + PostgreSQL + email-job workload under a shared 2 GiB memory limit (no swap,
  1 vCPU quota). It excluded host overhead (OS, Docker daemon, TLS proxy, SSH, monitoring) and several application paths
  (login/registration hashing, image upload, CSV/XLSX import, real Stripe/Resend, payment finalisation, the other two
  jobs, local or S3 image storage), used a tiny catalog, and is **not a guarantee of production capacity**. Argon2id uses
  `AUTH_ARGON_MEMORY_KIB` (19 MiB) per concurrent hash and `sharp` decodes uploaded images in memory — size and load-test
  the real configuration before launch. The image is ~1.5 GB.
- **TLS-terminating reverse proxy in front** (HTTPS only; the app sets HSTS). It must **overwrite** `X-Forwarded-For`
  with the real client address (rate limits and audit rows key on its first entry, so a client-supplied value is a
  bypass), pass the original `Host`/`Origin` (CSRF checks compare against `NEXT_PUBLIC_APP_URL`), and pass request
  bodies unmodified — the Stripe webhook verifies the raw body *(untested)*.
- **Exactly one web replica.** The login/registration/reset rate limiter and the Next.js cache live in process memory;
  N replicas multiply the limits and do not share cache. A rolling deploy with a brief overlap only briefly doubles
  limits; sustained horizontal scaling needs the shared-store limiter first (not built). Needs restart-on-failure.
- **PostgreSQL.** Version 17 is the only version tested. The code relies on row locks (`SELECT … FOR UPDATE`),
  transaction-scoped advisory locks and interactive transactions of up to 20 s — use direct connections or a
  *session*-mode pooler; transaction-mode pooling is *(untested)*. Two roles are advisable: a migration role with DDL
  rights (used only by the `migrate` target) and a runtime role with DML only. A separate, read-only backup role
  (`docs/backup-restore.md`). No extensions are required. TLS to the database is set in the connection string *(untested)*.
- **S3-compatible object storage** with: per-environment bucket; credentials with read/write/delete; **presigned
  browser uploads** (the bucket's CORS must allow `PUT` from the app origin *(untested in a real browser)*); a bucket
  policy giving anonymous read on `products/*` only and **none on `staging/*`** (what `docker-compose.yml`'s `minio-init`
  applies locally); a public base URL for finalized images (`S3_PUBLIC_BASE_URL`, path style `<base>/<bucket>/<key>`,
  also a build argument). Product images are **not** in database backups.
- **Outbound HTTPS (egress)** to `api.stripe.com` (web and the order job), `api.resend.com` (web and the email job),
  the database, and the object store. **Inbound public HTTPS** to `POST /api/webhooks/stripe`; no other public
  endpoint is needed for the jobs (they have none, and none is to be added).
- **Scheduler for three one-shot jobs** using the same image and environment: a facility that runs a container on a
  recurring schedule, captures its stdout/stderr and exit code, and alerts when a run is missing or fails
  (`docs/monitoring.md`). Overlapping runs are designed to be safe but were not load-tested.
- **Secrets/config injection at run time** (environment variables from a secret store — never baked into the image);
  `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` and `S3_PUBLIC_BASE_URL` are baked in at **build** time,
  so the host or CI must build one image per environment.
- **Reasonably accurate clock (NTP).** Token expiry, Stripe signature tolerance and the payment-claim age bands
  (10 min / 12 h) all depend on it. UTC throughout.
- **Log collection and external probes** as in `docs/monitoring.md`: liveness `/api/health` (container
  `HEALTHCHECK`) and readiness `/api/health/ready` from outside the network.

## Verified and not verified

See the Phase 13 entry in `docs/implementation-roadmap.md` for dated results and the open items.
