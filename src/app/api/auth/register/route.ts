import { NextResponse } from "next/server";

import { registerCustomer } from "@/server/auth";
import { registerSchema } from "@/lib/validation/auth";
import { route } from "@/lib/http/api-response";
import { guardMutation } from "@/lib/http/guard-request";
import { getRequestMeta } from "@/lib/http/request-meta";

export const dynamic = "force-dynamic";

/**
 * Customer self-registration. The body is parsed with a schema that keeps ONLY
 * firstName / lastName / email / password — any `role`, `status`,
 * `emailVerifiedAt` or permissions the client sends are dropped here, and
 * `registerCustomer` has no parameter for them anyway. The response is
 * identical whether the email was new or already registered (no account
 * enumeration); the only distinguishable failures are about the password
 * itself (weak) or rate limiting.
 */
export const POST = route(async (request: Request) => {
  await guardMutation(request);
  const input = registerSchema.parse(await request.json());
  await registerCustomer({ ...input, ...getRequestMeta(request) });
  return NextResponse.json({ ok: true });
});
