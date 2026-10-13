import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * LIVENESS probe: the process is up and answering HTTP. It deliberately does NOT touch the
 * database (so a database blip never makes an orchestrator restart a healthy process) and
 * reveals nothing about configuration — no environment name, no versions, no hostnames. Importing
 * `serverEnv` here is intentionally avoided; a misconfigured environment is caught by the app's
 * other routes failing and by the readiness probe (`/api/health/ready`).
 */
export function GET() {
  return NextResponse.json(
    { status: "ok", timestamp: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
