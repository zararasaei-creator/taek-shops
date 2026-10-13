#!/usr/bin/env bash
# Pre-release verification (CI) — host-neutral. Any CI host's job just checks out the
# repo, provides Node + Docker, and runs:   bash scripts/ci/verify.sh
# See docs/ci.md. It deploys nothing, publishes nothing, and uses no real secret.
#
# Steps: install -> typecheck -> lint -> unit -> [disposable Postgres + MinIO] ->
#        prisma migrate deploy (test DB only) -> integration -> e2e (fake payments,
#        local-preview email) -> production image build (runner + migrate targets) ->
#        image smoke (migrate target on a fresh DB, then boot + /api/health).
#
# Flags: --skip-install  --skip-e2e  --skip-image   (for local iteration only; a
# release gate runs without them).
set -euo pipefail
export MSYS_NO_PATHCONV=1   # git-bash on Windows: do not mangle container paths

SKIP_INSTALL=0; SKIP_E2E=0; SKIP_IMAGE=0
for arg in "$@"; do
  case "$arg" in
    --skip-install) SKIP_INSTALL=1 ;;
    --skip-e2e) SKIP_E2E=1 ;;
    --skip-image) SKIP_IMAGE=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 64 ;;
  esac
done

cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
RUN_ID="$$-$(date +%s)"
PROJECT="taekci-${RUN_ID}"
COMPOSE=(docker compose -p "$PROJECT" -f ci/docker-compose.ci.yml)
IMAGE_TAG="taekci-${RUN_ID}"
TMP="$(mktemp -d)"
STARTED=$(date +%s)
CURRENT_STEP="preflight"
FAILED=1

step() { CURRENT_STEP="$1"; echo; echo "=== [ci] $1 ($(( $(date +%s) - STARTED ))s elapsed)"; }

cleanup() {
  local code=$?
  set +e
  echo; echo "=== [ci] cleanup"
  docker rm -f "${PROJECT}-smoke-web" >/dev/null 2>&1
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1
  docker rmi "${IMAGE_TAG}:runner" "${IMAGE_TAG}:migrate" >/dev/null 2>&1
  rm -rf "$TMP"
  if [ "$FAILED" -eq 0 ]; then echo "=== [ci] PASSED in $(( $(date +%s) - STARTED ))s (local/script run — not a hosted CI result)"
  else echo "=== [ci] FAILED during: ${CURRENT_STEP} (exit ${code})" >&2; fi
  exit "$code"
}
trap cleanup EXIT

# ---------------------------------------------------------------- preflight ----
step "preflight"
command -v node >/dev/null && command -v docker >/dev/null || { echo "node and docker are required" >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
WANT="$(tr -d '[:space:]v' < .nvmrc)"
[ "$NODE_MAJOR" = "$WANT" ] || { echo "Node $NODE_MAJOR found but .nvmrc requires $WANT (same as the production image)" >&2; exit 1; }
# A developer's .env would silently fill any variable we do not set (the app, Prisma
# and Vitest all load it as a fallback) — i.e. could point this run at a real DB.
if [ -f .env ] && [ "${CI_VERIFY_ALLOW_DOTENV:-0}" != "1" ]; then
  echo "refusing to run: a .env file is present. Run from a clean checkout (CI has none)." >&2; exit 1
fi
# Never inherit anything that selects a real provider or a test bypass.
unset RESEND_API_KEY EMAIL_FROM_ADDRESS EMAIL_TRANSPORT PAYMENT_GATEWAY E2E_DIST_DIR \
      PAYMENT_CLAIMS_ACTIVE_SINCE LOCAL_STORAGE_ROOT SEED_ADMIN_EMAIL SEED_ADMIN_PASSWORD \
      DIRECT_DATABASE_URL SHADOW_DATABASE_URL AUTH_URL

rand() { node -e 'console.log(require("crypto").randomBytes(12).toString("hex"))'; }
export CI_PG_PASSWORD="$(rand)" CI_MINIO_USER="ci$(rand)" CI_MINIO_PASSWORD="$(rand)"
# Synthetic, never real. Stripe/webhook values only need to be well-formed; e2e uses
# the fake payment gateway and nothing here ever reaches a provider.
export CI=true   # Playwright: forbidOnly + retries as configured for CI
# Stripe-shaped placeholders are exported only AFTER the unit tests (tests/unit/setup.ts
# supplies its own and a unit test asserts on that exact placeholder); see provider_env.
provider_env() {
  export NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY="pk_test_ci_synthetic_not_a_real_key"
  export STRIPE_SECRET_KEY="sk_test_ci_synthetic_not_a_real_key"
  export STRIPE_WEBHOOK_SECRET="whsec_ci_synthetic_not_a_real_secret"
}
export AUTH_SECRET="$(rand)$(rand)"

# ----------------------------------------------------------------- install ----
if [ "$SKIP_INSTALL" -eq 0 ]; then
  step "install (npm ci — lockfile only)"
  timeout 900 npm ci
  if [ "$SKIP_E2E" -eq 0 ]; then
    step "playwright browser"
    if [ "${CI_PLAYWRIGHT_DEPS:-0}" = "1" ]; then timeout 600 npx playwright install --with-deps chromium
    else timeout 600 npx playwright install chromium; fi
  fi
fi

# ----------------------------------------------------- static + unit (no DB) ----
# DATABASE_URL must be a well-formed URL for env validation; unit tests mock Prisma.
export DATABASE_URL="postgresql://ci:unused@127.0.0.1:1/taek_ci_app?schema=public"
step "typecheck";  timeout 600 npm run typecheck
step "lint";       timeout 600 npm run lint
step "unit tests"; timeout 900 npm test

provider_env

# -------------------------------------------------- disposable PG + MinIO ----
step "start disposable PostgreSQL + MinIO (${PROJECT})"
timeout 300 "${COMPOSE[@]}" up -d --wait --wait-timeout 120
PG_PORT="$("${COMPOSE[@]}" port postgres 5432 | sed 's/.*://')"
S3_PORT="$("${COMPOSE[@]}" port minio 9000 | sed 's/.*://')"
"${COMPOSE[@]}" exec -T postgres psql -U ci -d postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE DATABASE taek_ci_test' -c 'CREATE DATABASE taek_ci_image' >/dev/null
export DATABASE_URL="postgresql://ci:${CI_PG_PASSWORD}@127.0.0.1:${PG_PORT}/taek_ci_app?schema=public"
export TEST_DATABASE_URL="postgresql://ci:${CI_PG_PASSWORD}@127.0.0.1:${PG_PORT}/taek_ci_test?schema=public"
export S3_ENDPOINT="http://127.0.0.1:${S3_PORT}" S3_REGION="us-east-1" S3_BUCKET="taek-ci-unused" \
       S3_ACCESS_KEY_ID="$CI_MINIO_USER" S3_SECRET_ACCESS_KEY="$CI_MINIO_PASSWORD" \
       S3_PUBLIC_BASE_URL="http://127.0.0.1:${S3_PORT}"
# Hard stop if anything resolved to a non-disposable host.
for u in "$DATABASE_URL" "$TEST_DATABASE_URL" "$S3_ENDPOINT"; do
  case "$u" in *@127.0.0.1:*|http://127.0.0.1:*) ;; *) echo "non-loopback target refused" >&2; exit 1 ;; esac
done

# Migrations: ONLY the disposable TEST database (never any other URL).
step "prisma migrate deploy (disposable test database only)"
DATABASE_URL="$TEST_DATABASE_URL" timeout 300 npx prisma migrate deploy

step "integration tests (disposable Postgres + MinIO)"
timeout 1500 npx vitest run --config vitest.integration.config.mts \
  --reporter=default --reporter=json --outputFile.json="$TMP/integration.json"
node scripts/ci/assert-integration-not-skipped.mjs "$TMP/integration.json"

if [ "$SKIP_E2E" -eq 0 ]; then
  # The e2e webServer runs `npm run build && npm run start` (production build into
  # .next-e2e), so this step is also the application-build gate — no separate build.
  step "e2e (production build; fake payments; local-preview email)"
  timeout 1800 npx playwright test --reporter=list
fi

# ------------------------------------------------------------ image build ----
if [ "$SKIP_IMAGE" -eq 0 ]; then
  step "docker build: runner (default target)"
  timeout 1500 docker build -t "${IMAGE_TAG}:runner" \
    --build-arg NEXT_PUBLIC_APP_URL=https://ci.example.test \
    --build-arg NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY="$NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY" \
    --build-arg S3_PUBLIC_BASE_URL=https://cdn.example.test/ci .
  step "docker build: migrate target"
  timeout 900 docker build --target migrate -t "${IMAGE_TAG}:migrate" .

  step "image smoke: migrate target on a fresh DB, then boot the runner"
  NET="${PROJECT}_default"
  INTERNAL_DB="postgresql://ci:${CI_PG_PASSWORD}@postgres:5432/taek_ci_image?schema=public"
  docker run --rm --network "$NET" -e DATABASE_URL="$INTERNAL_DB" "${IMAGE_TAG}:migrate"
  docker run -d --name "${PROJECT}-smoke-web" --network "$NET" \
    -e DATABASE_URL="$INTERNAL_DB" -e NEXT_PUBLIC_APP_URL=https://ci.example.test \
    -e STRIPE_SECRET_KEY -e STRIPE_WEBHOOK_SECRET -e AUTH_SECRET \
    "${IMAGE_TAG}:runner" >/dev/null
  healthy=0
  for _ in $(seq 1 40); do
    if docker exec "${PROJECT}-smoke-web" node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then healthy=1; break; fi
    sleep 2
  done
  [ "$healthy" -eq 1 ] || { docker logs "${PROJECT}-smoke-web" 2>&1 | tail -20 >&2; echo "runner never became healthy" >&2; exit 1; }
  echo "runner image booted and /api/health is ok"
fi

FAILED=0
