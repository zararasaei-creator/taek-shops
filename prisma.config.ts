import { loadEnvFile } from "node:process";

import { defineConfig } from "prisma/config";

/**
 * Prisma CLI configuration (replaces the deprecated `package.json#prisma` key).
 *
 * When a Prisma config file is present, the CLI no longer auto-loads `.env`, so
 * we load it here using Node's built-in loader (no extra dependency). Values
 * already present in the real environment (CI, production) take precedence and
 * a missing `.env` is not an error.
 */
try {
  loadEnvFile(".env");
} catch {
  // No .env file — configuration comes from the process environment.
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "node prisma/seed.ts",
  },
});
