import { NextResponse } from "next/server";

import { login } from "@/server/auth";
import { loginSchema } from "@/lib/validation/auth";
import { route } from "@/lib/http/api-response";
import { guardMutation } from "@/lib/http/guard-request";
import { getRequestMeta } from "@/lib/http/request-meta";

export const dynamic = "force-dynamic";

export const POST = route(async (request: Request) => {
  await guardMutation(request);

  const input = loginSchema.parse(await request.json());
  const meta = getRequestMeta(request);
  const { user } = await login({ ...input, meta });

  return NextResponse.json({ user });
});
