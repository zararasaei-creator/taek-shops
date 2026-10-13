#!/usr/bin/env bash
# Shared helpers for scripts/db/backup.sh and scripts/db/restore.sh (sourced, not run).
#
# PostgreSQL client tools run inside a postgres:<major> container by default, so the
# host needs only Docker and the client version always matches the server major
# (override with PG_TOOLS=native to use pg_dump/pg_restore/psql from PATH).
#
# Credentials: only ever read from the environment, passed to the tool by NAME
# (`docker run -e PGPASSWORD`), never placed on a command line, never echoed. These
# scripts print host, port and database NAME only — never the user's password and never
# a connection URL. `set -x` is forced off.

set +x
export MSYS_NO_PATHCONV=1   # git-bash on Windows: do not mangle container paths

PG_TOOLS_IMAGE="${PG_TOOLS_IMAGE:-postgres:17-alpine}"

log() { echo "[db] $*"; }
die() { echo "[db] ERROR: $*" >&2; exit "${2:-1}"; }
usage_die() { echo "[db] usage error: $*" >&2; exit 64; }

# Hosts that mean "this machine" — a container must reach them via the Docker host.
is_loopback() { case "$1" in localhost|127.0.0.1|::1|"[::1]") return 0 ;; *) return 1 ;; esac; }

# pg_run <tool> [args...]  — runs a Postgres client tool against $PGHOST/$PGPORT/$PGUSER
# with $PGPASSWORD (all already exported by the caller). stdin/stdout pass through.
pg_run() {
  if [ "${PG_TOOLS:-docker}" = "native" ]; then
    "$@"
    return
  fi
  local host="$PGHOST" net=()
  if [ -n "${PG_DOCKER_NETWORK:-}" ]; then
    net=(--network "$PG_DOCKER_NETWORK")
  elif is_loopback "$host"; then
    host="host.docker.internal"
    net=(--add-host=host.docker.internal:host-gateway)
  fi
  docker run --rm -i "${net[@]}" \
    -e PGPASSWORD -e PGPORT -e PGUSER -e PGSSLMODE -e PGCONNECT_TIMEOUT \
    -e "PGHOST=$host" \
    "$PG_TOOLS_IMAGE" "$@"
}

require_env() {
  local name
  for name in "$@"; do
    [ -n "${!name:-}" ] || usage_die "$name is required (set it in the environment; never on the command line)"
  done
}

# Absolute, symlink-resolved directory path.
abs_dir() { (cd "$1" 2>/dev/null && pwd -P); }

# Refuse an output location inside a git working tree (a dump must never be committable).
refuse_inside_git_tree() {
  local dir="$1" top
  if top="$(cd "$dir" && git rev-parse --show-toplevel 2>/dev/null)" && [ -n "$top" ]; then
    die "$dir is inside the git working tree $top — choose a directory outside any repository"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else node -e 'const c=require("crypto"),f=require("fs");console.log(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$1"; fi
}
