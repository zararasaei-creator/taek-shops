#!/usr/bin/env bash
# Restore a backup into a NEWLY CREATED, isolated database — and nowhere else.
#
#   RESTORE_PGHOST=… RESTORE_PGPORT=… RESTORE_PGUSER=… RESTORE_PGPASSWORD=… \
#   RESTORE_DB_NAME=restore_drill_20261008 \
#   RESTORE_CONFIRM=create-new-database:restore_drill_20261008 \
#     bash scripts/db/restore.sh /path/to/<name>.dump
#
# Exit codes: 0 restored · 1 failure (a database THIS run created is dropped again) ·
# 64 usage/safeguard refusal (nothing touched).
#
# Safeguards against restoring over dev or production — all enforced here, none optional:
#  1. Target database must NOT already exist: the script creates it itself. It can never
#     overwrite or add to an existing database (no --clean, no --create, no DROP of anything
#     it did not create in this run).
#  2. The name must match ^restore_[a-z0-9_]{1,40}$, so it can never equal an application,
#     dev, test or production database name; and it must differ from the dump's source name.
#  3. A separate, explicit confirmation string naming that database is required.
#  4. Its own RESTORE_PG* variable namespace: the ambient PG*/DATABASE_URL a developer or
#     server normally has can never silently become the restore target.
#  5. Refuses a target server that is the same host:port as DATABASE_URL / TEST_DATABASE_URL /
#     DIRECT_DATABASE_URL when those are set, unless RESTORE_ALLOW_SAME_SERVER_AS_APP=1
#     (even then, only a brand-new database is created next to it).
#  6. The archive must be readable and, when a .sha256 sidecar exists, match it.
# Credentials are read from the environment only and are never printed.
# See docs/backup-restore.md.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/db/_common.sh
source "$here/_common.sh"

[ $# -eq 1 ] || usage_die "usage: restore.sh <backup.dump>   (settings come from RESTORE_* environment variables)"
dump="$1"
[ -f "$dump" ] || usage_die "backup file not found: $dump"
require_env RESTORE_PGHOST RESTORE_PGUSER RESTORE_PGPASSWORD RESTORE_DB_NAME RESTORE_CONFIRM

name="$RESTORE_DB_NAME"
[[ "$name" =~ ^restore_[a-z0-9_]{1,40}$ ]] || usage_die "RESTORE_DB_NAME must match ^restore_[a-z0-9_]{1,40}$ (a brand-new, clearly-named database)"
[ "$RESTORE_CONFIRM" = "create-new-database:$name" ] || usage_die "RESTORE_CONFIRM must be exactly 'create-new-database:$name'"

# (4) Start from a clean PG* slate, then map ONLY the RESTORE_* values.
unset PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSERVICE PGPASSFILE PGOPTIONS PGSSLMODE
export PGHOST="$RESTORE_PGHOST" PGPORT="${RESTORE_PGPORT:-5432}" PGUSER="$RESTORE_PGUSER" \
       PGPASSWORD="$RESTORE_PGPASSWORD" PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-15}"

# (5) Not the application's own database server (unless explicitly allowed).
if [ "${RESTORE_ALLOW_SAME_SERVER_AS_APP:-0}" != "1" ]; then
  for var in DATABASE_URL TEST_DATABASE_URL DIRECT_DATABASE_URL; do
    url="${!var:-}"
    [ -n "$url" ] || continue
    app_hostport="$(node -e 'try{const u=new URL(process.argv[1]);console.log(u.hostname.toLowerCase()+":"+(u.port||"5432"))}catch{}' "$url")"
    ours="$(printf '%s' "$PGHOST" | tr 'A-Z' 'a-z'):$PGPORT"
    if [ -n "$app_hostport" ] && [ "$app_hostport" = "$ours" ]; then
      die "target server $ours is the server in \$$var — refusing (set RESTORE_ALLOW_SAME_SERVER_AS_APP=1 only if you are certain; a NEW database is still all this does)" 64
    fi
  done
fi

# (6) The archive: checksum (if present) and readability; learn the source database name.
if [ -f "$dump.sha256" ]; then
  expected="$(cut -d' ' -f1 "$dump.sha256")"
  [ "$(sha256_of "$dump")" = "$expected" ] || die "checksum mismatch — the backup is corrupt or was modified; not restoring" 64
  log "checksum verified"
elif [ "${RESTORE_SKIP_CHECKSUM:-0}" != "1" ]; then
  die "no $(basename "$dump").sha256 next to the backup; set RESTORE_SKIP_CHECKSUM=1 to proceed without one" 64
fi
listing="$(pg_run pg_restore --list < "$dump")" || die "not a readable pg_dump custom-format archive" 64
source_db="$(printf '%s\n' "$listing" | sed -n 's/^; *dbname: *//p' | head -1)"
[ "$source_db" != "$name" ] || die "target name equals the backup's source database name" 64
log "backup of '${source_db:-unknown}' -> NEW database '$name' on $PGHOST:$PGPORT"

# (1) Must not exist; we create it.
exists="$(pg_run psql --no-psqlrc -d postgres -tAX -v ON_ERROR_STOP=1 -c "SELECT 1 FROM pg_database WHERE datname = '$name'")" \
  || die "could not reach the target server"
[ -z "$exists" ] || die "database '$name' already exists — refusing (this script only restores into a database it creates)" 64

created=0
cleanup() {
  local code=$?
  if [ "$code" -ne 0 ] && [ "$created" -eq 1 ]; then
    echo "[db] restore failed — dropping the database this run created ('$name')" >&2
    pg_run psql --no-psqlrc -d postgres -qAtX -c "DROP DATABASE IF EXISTS \"$name\"" >/dev/null 2>&1 || \
      echo "[db] WARNING: could not drop '$name'; remove it manually" >&2
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

pg_run psql --no-psqlrc -d postgres -qAtX -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$name\"" >/dev/null
created=1

pg_run pg_restore --dbname="$name" --no-owner --no-privileges --exit-on-error --single-transaction --no-password \
  < "$dump" || die "pg_restore failed"

tables="$(pg_run psql --no-psqlrc -d "$name" -tAX -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")"
[ "${tables:-0}" -gt 0 ] || die "restored database has no tables"
log "OK  restored into new database '$name' ($tables tables). Verify before trusting it (docs/backup-restore.md); it is NOT wired to any application."
