import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/auth";
import { listUsers } from "@/server/users/user-management";
import { listUsersQuerySchema } from "@/lib/validation/auth";
import { route } from "@/lib/http/api-response";

export const dynamic = "force-dynamic";

/** GET /api/admin/users — requires the `user.read` permission (MANAGER+). */
export const GET = route(async (request: Request) => {
  const actor = await getCurrentUser();
  const url = new URL(request.url);
  const query = listUsersQuerySchema.parse(Object.fromEntries(url.searchParams));

  const result = await listUsers(actor, query);
  return NextResponse.json(result);
});
