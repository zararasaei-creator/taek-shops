import { NextResponse } from "next/server";

import { logout } from "@/server/auth";
import { route } from "@/lib/http/api-response";
import { guardMutation } from "@/lib/http/guard-request";
import { getRequestMeta } from "@/lib/http/request-meta";

export const dynamic = "force-dynamic";

export const POST = route(async (request: Request) => {
  await guardMutation(request);
  await logout(getRequestMeta(request));
  return NextResponse.json({ ok: true });
});
