import { NextResponse } from "next/server";

import { requestPasswordReset } from "@/server/auth";
import { passwordResetRequestSchema } from "@/lib/validation/auth";
import { route } from "@/lib/http/api-response";
import { guardMutation } from "@/lib/http/guard-request";
import { getRequestMeta } from "@/lib/http/request-meta";

export const dynamic = "force-dynamic";

/** Request a password-reset email. Always returns 200 (no account enumeration). */
export const POST = route(async (request: Request) => {
  await guardMutation(request);
  const { email } = passwordResetRequestSchema.parse(await request.json());
  await requestPasswordReset({ email, ...getRequestMeta(request) });
  return NextResponse.json({ ok: true });
});
