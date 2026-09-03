import { loadEnvFile } from "node:process";

/**
 * Integration tests talk to a real database. Load the project `.env` (the Prisma
 * CLI does the same via `prisma.config.ts`) so `DATABASE_URL` is the local
 * docker-compose Postgres, not the unit-test placeholder.
 *
 * This runs before any test module — and therefore before `@/server/db/client`
 * constructs the shared PrismaClient — so widening the connection pool here means
 * every service call in the suite (which uses that shared client) gets the
 * headroom the concurrency tests need: dozens of simultaneous interactive
 * transactions, each holding a connection while it waits on a `FOR UPDATE` lock.
 */
try {
  loadEnvFile(".env");
} catch {
  // No .env — rely on the ambient environment (CI).
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    "Integration tests need DATABASE_URL. Start Postgres (`docker compose up -d`), " +
      "apply migrations (`npm run db:deploy`), then re-run `npm run test:integration`.",
  );
}

if (!/[?&]connection_limit=/.test(process.env.DATABASE_URL)) {
  const sep = process.env.DATABASE_URL.includes("?") ? "&" : "?";
  process.env.DATABASE_URL = `${process.env.DATABASE_URL}${sep}connection_limit=60&pool_timeout=30`;
}
