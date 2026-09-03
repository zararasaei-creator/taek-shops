import { PrismaClient } from "@prisma/client";

import { serverEnv } from "@/server/config/env";

/**
 * Single shared PrismaClient.
 *
 * In development, Next.js hot-reloads modules on every edit; without this guard a
 * new client (and connection pool) would be created each time and eventually
 * exhaust database connections. In production a single module instance is used,
 * so the plain `new PrismaClient()` path applies.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: serverEnv.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (serverEnv.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
