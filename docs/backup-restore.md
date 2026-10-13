# Database backup and restore

Manual, host-agnostic procedures for the PostgreSQL database, verified by a restore drill on
synthetic data. **Not yet operational:** nothing here is scheduled, retained, encrypted at
rest, copied off the machine, or owned by a named person — see [Remaining work](#remaining-work-before-this-protects-real-orders).
**This covers the database only. It does not back up product-image objects** (see the same section).

Tools: `scripts/db/backup.sh`, `scripts/db/restore.sh`, `scripts/db/restore-drill.sh`,
`scripts/db/verify-restore.ts`. PostgreSQL client tools run in a `postgres:17-alpine` container by
default (host needs only Docker, and the client matches the server's major version; set
`PG_TOOLS_IMAGE` to match a different server, or `PG_TOOLS=native` to use `pg_dump`/`pg_restore`/`psql`
from `PATH`; `PG_DOCKER_NETWORK=<network>` to reach a database on a Docker network).

## Back up

```bash
PGHOST=<host> PGPORT=<port> PGUSER=<backup-role> PGDATABASE=<database> \
PGPASSWORD=<from your secret manager> BACKUP_DIR=<directory outside the repository> \
  bash scripts/db/backup.sh
```

- One **custom-format** `pg_dump` (`--format=custom --no-owner --no-privileges`), read-only on the database.
  Use a role that can read every table (a dedicated read-only role is recommended).
- Output: `<database>-<UTC timestamp>.dump` (+ `.dump.sha256`), mode 600, never overwriting an existing file.
- **Incomplete files are impossible to mistake for backups:** the dump is written to `….dump.partial`
  and renamed only after `pg_dump` exits 0, the archive is non-empty, and `pg_restore --list` can read it.
  On any failure or Ctrl-C the partial file is deleted. Exit codes: `0` ok · `1` failure · `64` usage.
- Refuses a `BACKUP_DIR` inside any git working tree (`*.dump*` is also git-ignored and excluded from the image).
- **Credentials**: only from the environment (`PGPASSWORD`, passed to the tool by name — never on a command
  line), never echoed; the scripts print host, port and database *name* only, never a URL or password.
  Do not put them in a file in the repository; supply them from your secret manager or an un-echoed `read -rs`.

A listing that succeeds proves the archive is readable, **not** that it restores. Only a restore does.

## Restore (into a brand-new, isolated database only)

```bash
RESTORE_PGHOST=<host> RESTORE_PGPORT=<port> RESTORE_PGUSER=<role allowed to CREATE DATABASE> \
RESTORE_PGPASSWORD=<from your secret manager> \
RESTORE_DB_NAME=restore_<something> \
RESTORE_CONFIRM=create-new-database:restore_<something> \
  bash scripts/db/restore.sh /path/to/<database>-<timestamp>.dump
```

Safeguards, all enforced by the script (none optional):

1. The target database **must not exist** — the script creates it. There is no `--clean`/`--create`, and it
   only ever drops a database it created itself in that run (when the restore fails).
2. The name must match `^restore_[a-z0-9_]{1,40}$` — it can never equal an application, dev, test or
   production database — and must differ from the backup's source name.
3. An explicit `RESTORE_CONFIRM` naming that database.
4. Its **own `RESTORE_PG*` variables**: ambient `PG*` / `DATABASE_URL` settings never become the target.
5. Refuses a target server equal to the host:port in `DATABASE_URL`, `TEST_DATABASE_URL` or
   `DIRECT_DATABASE_URL` unless `RESTORE_ALLOW_SAME_SERVER_AS_APP=1`.
6. Verifies the `.sha256` sidecar (or requires an explicit `RESTORE_SKIP_CHECKSUM=1`) and that the archive is readable.

Exit codes: `0` restored · `1` failure (the database it created is dropped) · `64` safeguard/usage refusal
(nothing touched). The restored database is **not connected to any application**. Before trusting it, verify
(next section). **Putting it into service** (pointing the app at it, or replacing production data) is a separate,
deliberate, reviewed operation that this procedure intentionally does not automate.

## The restore drill

```bash
bash scripts/db/restore-drill.sh        # needs Docker, Node and npm dependencies; ~1-2 min
```

Starts a throwaway PostgreSQL (tmpfs, loopback only), applies the migrations, fills a **synthetic**
database with related records using the application's own services and the existing integration fixtures
(users, products/variants/inventory, authenticated and guest orders, paid orders via the fake gateway, a partial
refund, a cancelled order, stock movements, audit rows), backs it up, proves the refusals and failure handling
above, restores into a new empty database, and then `verify-restore.ts` compares source and restored copy:
every table's row count **and a content fingerprint of every row**, schema parity (indexes/constraints/enums),
no orphaned foreign keys, order totals reconcile, financial totals and per-SKU inventory equal, the app's own
inventory reconciliation passes, and the restored data is read through the application's Prisma client and
services. It also checks `prisma migrate status` on the restored copy and that no password appears in any output.
Run it again after any schema change or change to these scripts.

To verify a **real** restore (a copy of production restored for a drill), run
`SOURCE_DATABASE_URL=… RESTORED_DATABASE_URL=… npx tsx scripts/db/verify-restore.ts` — note its app-read checks
look for the synthetic drill users, so for real data compare counts/fingerprints and run the application-level
checks you care about instead.

## Remaining work before this protects real orders

None of this has been decided or done — each needs an owner decision:

- **Schedule / RPO.** Backups are manual. Pick a cadence from how many hours of orders you can afford to lose
  (a daily dump loses up to a day). A dump is a single moment: **there is no point-in-time recovery** (PITR needs
  WAL archiving or a managed database's PITR feature — a hosting decision).
- **Retention.** How many daily/weekly/monthly copies, and how long; deletion must be deliberate, not accidental.
- **Encryption and access control.** Dumps contain customer names, addresses and order history (and password
  hashes). They are written unencrypted with owner-only file permissions; encryption at rest, who may read them,
  and where the backup role's credentials live are open.
- **Off-machine storage.** A backup on the same machine/volume as the database does not survive losing it. A second
  location (different failure domain) is required; no provider has been chosen or bought.
- **Restore ownership and rehearsal.** Name who performs a restore, who approves cutover, and rehearse the real
  cutover (point the app at the restored database, re-establish jobs and webhooks) — only the restore-and-verify
  half has been exercised.
- **Object storage is NOT covered.** Database backups contain image *references*, not the product-image objects
  in S3-compatible storage. Recovering images (versioning/replication/backup of the bucket, and what happens to
  `ProductImage` rows whose objects are lost) is a **separate, outstanding requirement**.
- **Secrets are not in these backups either** (environment variables, Stripe/Resend keys): keep them in a
  secret manager with its own recovery.
- Before each production migration: take and verify a backup first (`docs/deployment.md` §3).
