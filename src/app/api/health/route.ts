import { NextResponse } from "next/server";
import { serverEnv } from "@/server/config/env";

export const dynamic = "force-dynamic";

/**
 * Liveness probe. Confirms the process is up and that environment configuration
 * parsed successfully. Deliberately reports no secrets.
 */
export function GET() {
  return NextResponse.json({
    status: "ok",
    environment: serverEnv.NODE_ENV,
    timestamp: new Date().toISOString(),
  });
}
