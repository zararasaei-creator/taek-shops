import { NextResponse } from "next/server";

import { completePasswordReset } from "@/server/auth";
import { passwordResetCompleteSchema } from "@/lib/validation/auth";
import { route } from "@/lib/http/api-response";
import { guardMutation } from "@/lib/http/guard-request";
import { getRequestMeta } from "@/lib/http/request-meta";

export const dynamic = "force-dynamic";

export const POST = route(async (request: Request) => {
  await guardMutation(request);
  const input = passwordResetCompleteSchema.parse(await request.json());
  await completePasswordReset({ ...input, ...getRequestMeta(request) });
  return NextResponse.json({ ok: true });
});
