import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/auth";
import { createVariant } from "@/server/catalog/variant-service";
import { variantCreateSchema } from "@/lib/validation/catalog";
import { route } from "@/lib/http/api-response";
import { guardMutation } from "@/lib/http/guard-request";
import { getRequestMeta } from "@/lib/http/request-meta";

export const dynamic = "force-dynamic";

export const POST = route(async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
  await guardMutation(request);
  const { id } = await ctx.params;
  const body = variantCreateSchema.parse(await request.json());
  const variant = await createVariant(await getCurrentUser(), id, {
    ...body,
    ...getRequestMeta(request),
  });
  return NextResponse.json({ variant }, { status: 201 });
});
