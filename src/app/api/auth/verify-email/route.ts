import { NextResponse } from "next/server";

import { confirmEmailVerification } from "@/server/auth";
import { emailVerificationConfirmSchema } from "@/lib/validation/auth";
import { route } from "@/lib/http/api-response";
import { guardMutation } from "@/lib/http/guard-request";
import { getRequestMeta } from "@/lib/http/request-meta";

export const dynamic = "force-dynamic";

export const POST = route(async (request: Request) => {
  await guardMutation(request);
  const { token } = emailVerificationConfirmSchema.parse(await request.json());
  await confirmEmailVerification({ token, ...getRequestMeta(request) });
  return NextResponse.json({ ok: true });
});
