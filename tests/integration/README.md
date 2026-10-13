# Integration tests (`tests/integration`)

Database-backed tests (real Postgres, no mocks) for inventory, checkout,
payments/webhooks, and catalog import. They run real deletes as part of
fixture cleanup, so they require a database **completely separate from the
application's own `DATABASE_URL`** — never the dev database.

## One-time local setup

Uses the same local Postgres container as the app (`docker-compose.yml`) — a
second, isolated database and a role limited to it, not a second server.

```bash
# Inside the running postgres container (adjust the admin user/db if yours differ):
docker exec -it taek-shops-postgres psql -U taek -d taek_shops

-- In psql:
CREATE ROLE taek_test LOGIN PASSWORD '<choose a strong password>';
CREATE DATABASE taek_shops_test OWNER taek_test;
-- Postgres grants PUBLIC (i.e. every role) CONNECT on new databases by
-- default. Revoke it so `taek_test` cannot reach the app's own database:
REVOKE CONNECT ON DATABASE taek_shops FROM PUBLIC;
```

Then set, in your local `.env` (never commit real values):

```
TEST_DATABASE_URL="postgresql://taek_test:<password>@localhost:5432/taek_shops_test?schema=public"
```

Apply the existing migrations to the **test** database only — explicitly
scope the connection to that command, never rely on `.env`'s `DATABASE_URL`:

```bash
DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy
```

(`TEST_DATABASE_URL` would need to already be exported in your shell for that
substitution — or just paste the connection string directly. Never run
`db:seed`, `db:reset`, or the app's own `db:deploy` against this database;
integration tests create only the small, namespaced fixtures they need.)

## Isolation safeguard

`tests/integration/helpers/setup.ts` runs before any test module and
**fails closed** — refuses to run anything — unless it can confirm
`TEST_DATABASE_URL`:

- is set at all;
- is not byte-identical to `DATABASE_URL`;
- resolves to a **different database name** than `DATABASE_URL` (checked
  independently of host/port — a matching hostname or IP alone is not
  accepted as proof of isolation, since `localhost`, `127.0.0.1`, and a
  container name can all reach the same server and database);
- is not host/port/database-identical to `DATABASE_URL` after parsing.

Once confirmed, it overwrites `process.env.DATABASE_URL` for the test
process only, before any application module or Prisma client is
constructed — the running dev server's own environment is never touched.

## Running

```bash
npm run test:integration
```

If you see `TEST_DATABASE_URL` errors, the safeguard is working as intended
— follow the setup above rather than pointing it at the app's database.
