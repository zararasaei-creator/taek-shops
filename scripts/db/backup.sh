#!/usr/bin/env bash
# Manual PostgreSQL backup: one custom-format pg_dump archive. READ-ONLY on the database.
#
#   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=… PGPASSWORD=… BACKUP_DIR=/secure/outside/repo \
#     bash scripts/db/backup.sh
#
# (PGPASSWORD from your secret manager / an un-echoed `read -rs`; never typed into a
# command line, never committed.) Exit codes: 0 verified backup written · 1 failure
# (nothing is left behind except an error message) · 64 usage error.
#
# Safety:
#  - The dump is written to `<name>.dump.partial` (mode 600) and only renamed to its final
#    name after pg_dump exited 0, the archive is non-empty and `pg_restore --list` can read
#    it. Any failure — or Ctrl-C — deletes the partial file; a half-written file can never
#    be mistaken for a backup. An existing backup is never overwritten.
#  - Refuses to write inside a git working tree.
#  - A `<name>.dump.sha256` sidecar is written; `restore.sh` verifies it.
# See docs/backup-restore.md. This does NOT back up object storage (product images).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/db/_common.sh
source "$here/_common.sh"

require_env PGHOST PGUSER PGDATABASE PGPASSWORD BACKUP_DIR
export PGPORT="${PGPORT:-5432}" PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-15}"
[[ "$PGDATABASE" =~ ^[A-Za-z0-9_.-]+$ ]] || usage_die "PGDATABASE has unexpected characters"

umask 077
[ -d "$BACKUP_DIR" ] || die "BACKUP_DIR does not exist: $BACKUP_DIR"
dir="$(abs_dir "$BACKUP_DIR")"
refuse_inside_git_tree "$dir"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
final="$dir/${PGDATABASE}-${stamp}.dump"
partial="${final}.partial"
[ ! -e "$final" ] || die "refusing to overwrite existing backup: $final"

complete=0
cleanup() { if [ "$complete" -ne 1 ]; then rm -f "$partial" "${final}.sha256"; fi; }
trap cleanup EXIT
trap 'exit 130' INT TERM

log "backing up database '$PGDATABASE' on $PGHOST:$PGPORT (read-only, custom format)"
pg_run pg_dump --format=custom --compress=6 --no-owner --no-privileges --no-password \
  --dbname="$PGDATABASE" > "$partial" || die "pg_dump failed — partial file removed"

[ -s "$partial" ] || die "backup is empty — partial file removed"
entries="$(pg_run pg_restore --list < "$partial" | grep -vc '^;' || true)"
[ "${entries:-0}" -gt 0 ] || die "archive is unreadable or has no objects — partial file removed"

sum="$(sha256_of "$partial")"
printf '%s  %s\n' "$sum" "$(basename "$final")" > "${final}.sha256"
mv "$partial" "$final"
chmod 600 "$final" "${final}.sha256"
complete=1

size="$(wc -c < "$final" | tr -d ' ')"
log "OK  $final"
log "    size=${size} bytes  objects=${entries}  sha256=${sum}"
log "    (listing proves the archive is readable, NOT that it restores — run the restore drill: docs/backup-restore.md)"
