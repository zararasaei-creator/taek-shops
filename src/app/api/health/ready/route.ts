import { NextResponse } from "next/server";

import { prisma } from "@/server/db/client";
import { checkReadiness } from "@/server/observability/readiness";

export const dynamic = "force-dynamic";

/**
 * Readiness probe: 200 `{"status":"ready"}` when the database answers a trivial query within
 * the timeout, otherwise 503 `{"status":"unavailable"}`. The body never says why (the reason is
 * logged internally as a category). Use it for "is the site actually working" uptime checks and
 * load-balancer routing — NOT for container restarts (see `/api/health`, liveness).
 */
export async function GET() {
  const ready = await checkReadiness(prisma);
  return NextResponse.json(
    { status: ready ? "ready" : "unavailable" },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
