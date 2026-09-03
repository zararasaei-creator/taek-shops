import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/server/auth";
import { changeUserRole, getUser, setAccountStatus } from "@/server/users/user-management";
import { route } from "@/lib/http/api-response";
import { guardMutation } from "@/lib/http/guard-request";
import { getRequestMeta } from "@/lib/http/request-meta";
import { UserRole, UserStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    role: z.enum(UserRole).optional(),
    status: z.enum(UserStatus).optional(),
  })
  .refine((value) => value.role !== undefined || value.status !== undefined, {
    message: "Provide `role` and/or `status`.",
  });

export const GET = route(
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const actor = await getCurrentUser();
    const user = await getUser(actor, id);
    return NextResponse.json({ user });
  },
);

export const PATCH = route(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    await guardMutation(request);
    const { id } = await context.params;
    const actor = await getCurrentUser();
    const meta = getRequestMeta(request);
    const body = patchSchema.parse(await request.json());

    let user = await getUser(actor, id);
    if (body.role !== undefined) {
      user = await changeUserRole(actor, { userId: id, role: body.role, ...meta });
    }
    if (body.status !== undefined) {
      user = await setAccountStatus(actor, { userId: id, status: body.status, ...meta });
    }
    return NextResponse.json({ user });
  },
);
