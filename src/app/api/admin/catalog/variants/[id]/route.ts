import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/auth";
import { archiveVariant, updateVariant } from "@/server/catalog/variant-service";
import { variantUpdateSchema } from "@/lib/validation/catalog";
import { route } from "@/lib/http/api-response";
import { guardMutation } from "@/lib/http/guard-request";
import { getRequestMeta } from "@/lib/http/request-meta";

export const dynamic = "force-dynamic";

export const PATCH = route(async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
  await guardMutation(request);
  const { id } = await ctx.params;
  const body = variantUpdateSchema.parse(await request.json());
  const variant = await updateVariant(await getCurrentUser(), id, {
    ...body,
    ...getRequestMeta(request),
  });
  return NextResponse.json({ variant });
});

export const DELETE = route(async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
  await guardMutation(request);
  const { id } = await ctx.params;
  const variant = await archiveVariant(await getCurrentUser(), id, getRequestMeta(request));
  return NextResponse.json({ variant });
});
