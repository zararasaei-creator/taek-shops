#!/usr/bin/env bash
# Backup-and-restore DRILL on synthetic data, entirely inside a throwaway PostgreSQL
# container. Proves a backup can be restored and that the restored copy equals the source.
# Touches nothing else: not the dev database, not any .env value, no external service.
#
#   bash scripts/db/restore-drill.sh
#
# Steps: disposable Postgres -> migrate (disposable DB only) -> seed representative related
# records with the app's own services (fake payments) -> backup.sh -> safeguard checks
# (refusals + failure handling) -> restore.sh into a NEW empty database -> verify-restore.ts
# (counts, fingerprints, FKs, financial totals, inventory, reads through the app) ->
# `prisma migrate status` on the restored copy -> tear everything down.
# Exit 0 only if every step passed.
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
here="$ROOT/scripts/db"

ID="$$-$(date +%s)"
NAME="taekdrill-$ID"
NET="$NAME-net"
WORK="$(mktemp -d)"
# Node (a native Windows binary under git-bash) needs a path it understands; bash keeps its own.
NODE_WORK="$(cd "$WORK" && (pwd -W 2>/dev/null || pwd))"
STEP="start"
PASS=0
step() { STEP="$1"; echo; echo "=== [drill] $1"; }
cleanup() {
  local code=$?
  set +e
  docker rm -f "$NAME" >/dev/null 2>&1
  docker rmi "$NAME-failstub" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  rm -rf "$WORK"
  if [ "$PASS" -eq 1 ]; then echo; echo "=== [drill] PASSED (synthetic data, disposable database)"; else echo; echo "=== [drill] FAILED during: $STEP (exit $code)" >&2; fi
  exit "$code"
}
trap cleanup EXIT

rand() { node -e 'console.log(require("crypto").randomBytes(12).toString("hex"))'; }
expect_fail() { # expect_fail "label" <exit-code-predicate: nonzero> -- command...
  local label="$1"; shift
  if "$@" >"$WORK/out.txt" 2>&1; then echo "UNEXPECTED SUCCESS: $label" >&2; cat "$WORK/out.txt" >&2; exit 1; fi
  cat "$WORK/out.txt" >> "$WORK/refusals.out"
  echo "refused as designed: $label  ($(grep -m1 -E 'ERROR|usage error' "$WORK/out.txt" | cut -c1-120))"
}

step "start a disposable PostgreSQL (tmpfs, loopback only, synthetic credentials)"
export PW="$(rand)"
docker network create "$NET" >/dev/null
docker run -d --name "$NAME" --network "$NET" --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_USER=drill -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=drill_source \
  -p 127.0.0.1::5432 postgres:17-alpine >/dev/null
for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U drill -d drill_source >/dev/null 2>&1 && break; sleep 1; done
PORT="$(docker port "$NAME" 5432/tcp | head -1 | sed 's/.*://')"
[ -n "$PORT" ] && [ "$PORT" != "5432" ] || { echo "unexpected port" >&2; exit 1; }
SRC_URL="postgresql://drill:${PW}@127.0.0.1:${PORT}/drill_source?schema=public"

step "migrate the disposable SOURCE database (prisma migrate deploy)"
DATABASE_URL="$SRC_URL" npx prisma migrate deploy >/dev/null
echo "migrations applied"

step "seed representative related records (app services + existing fixtures, fake payments)"
DATABASE_URL="$SRC_URL" NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_drill_synthetic \
  STRIPE_SECRET_KEY=sk_test_drill_synthetic STRIPE_WEBHOOK_SECRET=whsec_drill_synthetic \
  npx tsx scripts/db/drill-seed.ts

step "backup (scripts/db/backup.sh)"
mkdir "$WORK/backups"
export PGHOST=127.0.0.1 PGPORT="$PORT" PGUSER=drill PGDATABASE=drill_source PGPASSWORD="$PW" BACKUP_DIR="$WORK/backups"
bash "$here/backup.sh" 2>&1 | tee "$WORK/backup.out"
DUMP="$(ls "$WORK"/backups/*.dump)"
[ -f "$DUMP.sha256" ] && [ "$(ls "$WORK/backups" | grep -c partial || true)" = "0" ] || { echo "backup artefacts wrong" >&2; exit 1; }

step "backup failure handling: wrong password and in-repo output both fail loudly and leave no file"
before="$(ls "$WORK/backups" | wc -l)"
expect_fail "wrong password" env PGPASSWORD=wrong bash "$here/backup.sh"
[ "$(ls "$WORK/backups" | wc -l)" = "$before" ] || { echo "a file was left behind" >&2; exit 1; }
mkdir -p "$ROOT/.drill-should-not-exist" && expect_fail "BACKUP_DIR inside the git working tree" env BACKUP_DIR="$ROOT/.drill-should-not-exist" bash "$here/backup.sh"
rmdir "$ROOT/.drill-should-not-exist"

# Restore settings: a SEPARATE namespace; the ambient PG*/DATABASE_URL is never the target.
export RESTORE_PGHOST=127.0.0.1 RESTORE_PGPORT="$PORT" RESTORE_PGUSER=drill RESTORE_PGPASSWORD="$PW"
unset PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD BACKUP_DIR

step "restore safeguards (each must refuse and change nothing)"
expect_fail "name without the restore_ prefix (e.g. the source/app database name)" \
  env RESTORE_DB_NAME=drill_source RESTORE_CONFIRM=create-new-database:drill_source bash "$here/restore.sh" "$DUMP"
expect_fail "missing/incorrect confirmation" \
  env RESTORE_DB_NAME=restore_drill RESTORE_CONFIRM=yes bash "$here/restore.sh" "$DUMP"
expect_fail "target server is the app's own server (DATABASE_URL)" \
  env DATABASE_URL="$SRC_URL" RESTORE_DB_NAME=restore_drill RESTORE_CONFIRM=create-new-database:restore_drill bash "$here/restore.sh" "$DUMP"
cp "$DUMP" "$WORK/tampered.dump"; cp "$DUMP.sha256" "$WORK/tampered.dump.sha256"
printf 'X' | dd of="$WORK/tampered.dump" bs=1 seek=200 conv=notrunc 2>/dev/null
expect_fail "corrupt/modified archive (checksum mismatch)" \
  env RESTORE_DB_NAME=restore_drill RESTORE_CONFIRM=create-new-database:restore_drill bash "$here/restore.sh" "$WORK/tampered.dump"
head -c 1000 "$DUMP" > "$WORK/truncated.dump"
expect_fail "truncated archive without a checksum" \
  env RESTORE_DB_NAME=restore_drill RESTORE_CONFIRM=create-new-database:restore_drill bash "$here/restore.sh" "$WORK/truncated.dump"
expect_fail "unreadable archive even when the checksum requirement is waived" \
  env RESTORE_SKIP_CHECKSUM=1 RESTORE_DB_NAME=restore_drill RESTORE_CONFIRM=create-new-database:restore_drill bash "$here/restore.sh" "$WORK/truncated.dump"
# A restore that fails AFTER its database was created must drop that database and leave nothing
# behind. pg_restore is replaced (by a throwaway local image that delegates `--list` but fails any
# real restore) so the failure path of restore.sh itself is exercised, with no test hook in the script.
docker build -q -t "$NAME-failstub" - >/dev/null <<'DOCKERFILE'
FROM postgres:17-alpine
RUN mv /usr/local/bin/pg_restore /usr/local/bin/pg_restore.real \
 && printf '#!/bin/sh\ncase "$*" in *--list*) exec pg_restore.real "$@";; *) echo "simulated pg_restore failure" >&2; exit 1;; esac\n' > /usr/local/bin/pg_restore \
 && chmod +x /usr/local/bin/pg_restore
DOCKERFILE
expect_fail "restore that fails after the database was created" \
  env PG_TOOLS_IMAGE="$NAME-failstub" RESTORE_DB_NAME=restore_failcase RESTORE_CONFIRM=create-new-database:restore_failcase bash "$here/restore.sh" "$DUMP"
[ -z "$(docker exec "$NAME" psql -U drill -d postgres -qAtc "SELECT 1 FROM pg_database WHERE datname='restore_failcase'")" ] || { echo "failed restore left its database behind" >&2; exit 1; }
echo "failed restore cleaned up after itself (no leftover database)"
# A database that already exists is never touched.
docker exec "$NAME" psql -U drill -d postgres -qAtc 'CREATE DATABASE restore_existing' >/dev/null
docker exec "$NAME" psql -U drill -d restore_existing -qAtc 'CREATE TABLE keepme(x int); INSERT INTO keepme VALUES (42)' >/dev/null
expect_fail "target database already exists" \
  env RESTORE_DB_NAME=restore_existing RESTORE_CONFIRM=create-new-database:restore_existing bash "$here/restore.sh" "$DUMP"
[ "$(docker exec "$NAME" psql -U drill -d restore_existing -qAtc 'SELECT x FROM keepme')" = "42" ] || { echo "existing database was modified" >&2; exit 1; }
echo "existing database untouched"
# The source is untouched by all of the above.

step "RESTORE into a NEW empty database (scripts/db/restore.sh)"
export RESTORE_DB_NAME=restore_drill RESTORE_CONFIRM=create-new-database:restore_drill
bash "$here/restore.sh" "$DUMP" 2>&1 | tee "$WORK/restore.out"
RESTORED_URL="postgresql://drill:${PW}@127.0.0.1:${PORT}/restore_drill?schema=public"

step "verify: source vs restored (counts, fingerprints, FKs, totals, inventory, reads through the app)"
SOURCE_DATABASE_URL="$SRC_URL" RESTORED_DATABASE_URL="$RESTORED_URL" \
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_drill_synthetic DATABASE_URL="$RESTORED_URL" \
  npx tsx scripts/db/verify-restore.ts

step "credentials never appeared in any script output"
if grep -qF -- "$PW" "$WORK/backup.out" "$WORK/restore.out" "$WORK/refusals.out"; then echo "PASSWORD LEAKED INTO OUTPUT" >&2; exit 1; fi
echo "the database password is absent from backup, restore and every refusal message"

step "the restored copy carries the migration history (prisma migrate status)"
DATABASE_URL="$RESTORED_URL" npx prisma migrate status 2>&1 | grep -E "Database schema is up to date|migrations found"

PASS=1
