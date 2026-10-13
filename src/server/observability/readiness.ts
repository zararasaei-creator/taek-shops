import type { PrismaClient } from "@prisma/client";

import { errorFields, logError } from "@/server/observability/logger";

/**
 * Readiness = "can this instance serve real requests right now": today, can it reach and query
 * its database. Distinct from LIVENESS (`/api/health`), which only proves the process is up and
 * answering — see `docs/monitoring.md` for which probe belongs where.
 *
 * Failure is reported to the caller as a bare boolean and to the logs as a category only: a
 * public probe must never learn why (connection strings and driver messages can contain
 * hostnames and credentials).
 */

export const READINESS_TIMEOUT_MS = 3000;

export async function checkReadiness(
  db: Pick<PrismaClient, "$queryRaw">,
  timeoutMs: number = READINESS_TIMEOUT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("readiness check timed out");
      error.name = "TimeoutError";
      reject(error);
    }, timeoutMs);
  });
  try {
    await Promise.race([db.$queryRaw`SELECT 1`, timeout]);
    return true;
  } catch (error) {
    logError("health.readiness_failed", { check: "database", timeoutMs, ...errorFields(error) });
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
