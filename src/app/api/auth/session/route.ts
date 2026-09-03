import { NextResponse } from "next/server";

import { getAuthContext } from "@/server/auth";
import { ensureCsrfCookie } from "@/server/auth/cookies";
import { route } from "@/lib/http/api-response";

export const dynamic = "force-dynamic";

/**
 * Returns the current user (or null) and ensures a CSRF token cookie exists.
 * Clients call this before any mutating request to obtain the token.
 */
export const GET = route(async () => {
  const csrfToken = await ensureCsrfCookie();
  const context = await getAuthContext();

  return NextResponse.json({
    user: context?.user ?? null,
    csrfToken,
  });
});
