# Monitoring runbook (logs, jobs, health, webhooks)

What the application emits so that a **future** host can notice trouble. Nothing here collects,
stores, ships or alerts on anything by itself — no monitoring SDK, account, dashboard or alerting
service exists, and no scheduler is configured. Those are activation tasks
([Pending activation](#pending-activation-not-provided-by-the-repository)).

## 1. Log format

Every structured line is one JSON object on stdout (`info`) or stderr (`warn`/`error`):

```json
{"runId":"mgb2k1-x7q2","job":"emails:dispatch","status":"ok","durationMs":412,"claimed":3,"sent":3,
 "notSent":0,"ts":"2026-10-08T14:00:00.412Z","level":"info","event":"job.completed","service":"taek-shops"}
```

Always present: `ts` (ISO-8601 UTC), `level`, `event`, `service`. Correlation: `runId` ties all lines of one
job run together; `eventId` (the Stripe event id) ties repeated webhook failures to one delivery. Other
lines (Next.js start-up banner, Prisma warnings) are plain text: a collector should parse each line as JSON
and keep non-JSON lines as raw text. Logger source: `src/server/observability/logger.ts`.

**What is never logged** — enforced centrally by the logger, not just by convention: passwords, tokens,
cookies, authorization headers, connection strings, provider keys, webhook payloads or signatures, customer
names/addresses/emails, email contents. Errors appear only as `errorName` + `errorCategory` (e.g.
`database:P2002`, `provider:ambiguous`, `unexpected`) — never the error message, stack or cause, because
provider and database messages can echo request data. Only internal ids (order, upload, Stripe event) are
logged. Limit: a bare secret with no recognisable shape in an innocuously named free-text field cannot be
detected, which is why call sites pass identifiers and counts, not free text.

## 2. Events

| Event | Level | Meaning / action |
| --- | --- | --- |
| `job.started` / `job.completed` / `job.failed` | info / info or warn / error | One pair per job run (`job`, `runId`, `durationMs`). `completed` carries `status`: `ok`; `completed_with_errors`, `attention_required`, `skipped` (all warn). `job.failed` = the run crashed (exit code 1). |
| `orders_expire.configuration_required` | error | `PAYMENT_CLAIMS_ACTIVE_SINCE` unset; orders preserved; job exits 1. Fix the config. |
| `orders_expire.items_failed` | error | Some orders could not be processed (left untouched, retried next run; job exits 1). `orderIds` lists them. |
| `orders_expire.claim_needs_review`, `orders_expire.legacy_needs_review` | warn | Stock held pending manual reconciliation (roadmap runbooks). `orderIds`. |
| `image_cleanup.upload_retry_scheduled` / `image_cleanup.upload_gave_up` | error | A storage delete failed (retried later) / exhausted retries (`storageKey` may still exist). |
| `order_email.send_failed` | error | Resend rejected/failed a send (`orderNumber`, `providerStatus`, `retryable`); the outbox retries. |
| `order_email.dispatch_kick_failed` | error | The best-effort send right after payment failed; `emails:dispatch` will retry. |
| `stripe_webhook.processing_failed` | error | Unexpected failure handling a verified webhook (`eventId`, `eventType`, `stage`). Response is 500 so **Stripe retries**; nothing was consumed. |
| `stripe_webhook.rejected` | warn | Bad/missing signature (400). A burst = probing, or the signing secret is wrong. |
| `stripe_webhook.not_configured` | error | Stripe keys missing; every delivery gets 503. Fix the config. |
| `api.unhandled_error` | error | An unexpected exception in an API route handler (`route()` wrapper): `method`, `path` (no query string), `requestId` when the proxy supplied `x-request-id`, `errorName`, `errorCategory`. The client only ever sees the generic 500 body. Expected errors (validation, auth, not-found, conflict, CSRF) are not logged. |
| `health.readiness_failed` | error | The readiness probe could not reach the database (`errorCategory`; `timeout` if slow). |

## 3. Health probes — which one for what

| Endpoint | Answers | Touches DB | Use for |
| --- | --- | --- | --- |
| `GET /api/health` | **Liveness** — the process is up and serving HTTP. `200 {"status":"ok","timestamp":…}` | No | Container `HEALTHCHECK` (already in the image), restart decisions, "is the site reachable at all" |
| `GET /api/health/ready` | **Readiness** — the instance can serve real requests (database answers `SELECT 1` within 3 s). `200 {"status":"ready"}` or `503 {"status":"unavailable"}` | Yes | Uptime monitor for "is the shop working", load-balancer routing |

Both return fixed bodies only — no environment, version, hostname, configuration or error detail (the reason a
readiness check failed goes to the log as `health.readiness_failed`, category only). Reading the pair:
liveness fails → process/network/proxy down; liveness OK but readiness 503 → database problem (do **not**
restart the web process for that). Neither probe checks Stripe, email or object storage.

## 4. Detecting problems (rules a future monitor should implement)

- **A job failed:** a `job.failed` event for the job, or its container/process exited non-zero. Also page-worthy:
  `orders_expire.configuration_required`, `orders_expire.items_failed`, `image_cleanup.upload_gave_up`.
- **A job did not run (the failure that logs nothing):** alert on the *absence* of `job.completed` for a job
  within ~2.5× its schedule (e.g. `emails:dispatch` every 5 min → none for 15 min; `orders:expire-abandoned`
  every 30 min → none for 75 min). A dead scheduler, a crashed container that never started, or a missing
  secret produces no `job.failed` line, so this absence rule is the only way to catch it. `job.started`
  without a following `job.completed`/`job.failed` for the same `runId` means the run was killed mid-way.
- **Unhealthy HTTP:** an external checker hitting both probes every 30–60 s from outside the network; alert on
  2–3 consecutive failures (liveness: not 200 or `status` ≠ `ok`; readiness: not 200 or `status` ≠ `ready`).
- **Repeated webhook failures:** `stripe_webhook.processing_failed` is expected to be rare. Alert when the **same
  `eventId` fails ≥ 3 times** (Stripe is retrying and we keep failing — orders may be stuck unpaid) or when more
  than a few failures occur within 5 minutes. Also watch for any `stripe_webhook.not_configured`, and a burst of
  `stripe_webhook.rejected`. Stripe's own dashboard shows delivery failures and emails the account owner;
  enable that as a second, independent signal.
- **Stuck money/stock:** `orders_expire.*_needs_review` and `legacy_needs_review` mean reserved stock awaiting a human.

## 5. Collecting the logs (host-agnostic)

The application writes only to stdout/stderr. A host collects them with whatever it provides for container logs
(Docker logging driver, systemd-journald, a platform log service, a sidecar agent) — keep the one-shot job containers'
logs too, since a job's whole story is its stdout/stderr and an exit code. Required of that pipeline: keep lines
intact (one JSON object per line), retain at least long enough to investigate a weekend outage, restrict who can
read logs (identifiers and order numbers appear), and index at least `event`, `level`, `job`, `runId`, `eventId`.

## Pending activation (not provided by the repository)

Log shipping and retention · alert rules and delivery (email/SMS/pager) and **who is on call** · an external uptime
checker for the two probes · the scheduler for the three jobs and its own failure alerting · Stripe webhook failure
notifications configured on the Stripe account · the dashboards (none are built). Errors raised by Next.js itself
(server components, server actions, pages) are logged by Next.js in its own plain-text format, not by this logger.
