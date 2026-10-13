import { NextResponse } from "next/server";

import { getCurrentUser, resendVerificationForUser } from "@/server/auth";
import { route } from "@/lib/http/api-response";
import { guardMutation } from "@/lib/http/guard-request";
import { getRequestMeta } from "@/lib/http/request-meta";

export const dynamic = "force-dynamic";

/**
 * Authenticated "resend verification email". Takes no body: the address comes
 * from the session, never from the client. Rate-limited (per email and IP) by
 * the existing `requestEmailVerification`. Unlike the public flows it reports
 * a send failure honestly (502) — the caller is signed in, so nothing is
 * enumerable.
 */
export const POST = route(async (request: Request) => {
  await guardMutation(request);
  const user = await getCurrentUser();
  const result = await resendVerificationForUser(user, getRequestMeta(request));
  return NextResponse.json({ ok: true, result });
});
