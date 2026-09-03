import { defineConfig } from "vitest/config";

/**
 * Database-backed integration tests (Phase 5). These require a reachable
 * PostgreSQL at `DATABASE_URL` with the migrations applied — run
 * `docker compose up -d && npm run db:deploy` first, then `npm run test:integration`.
 *
 * Separate from the unit config (`vitest.config.mts`, mocked Prisma, jsdom):
 * - `environment: node` — no DOM.
 * - `fileParallelism: false` + `maxWorkers: 1` — files run one at a time in a
 *   single process so they never race each other's rows. Concurrency *within* a
 *   test is explicit (`Promise.all` over real transactions).
 * - generous timeouts — real transactions, real row-lock contention.
 */
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/integration/**/*.integration.test.ts"],
    setupFiles: ["./tests/integration/helpers/setup.ts"],
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
