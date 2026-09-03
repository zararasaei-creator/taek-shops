import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/auth";
import { getCategory, updateCategory } from "@/server/catalog/category-service";
import { categoryUpdateSchema } from "@/lib/validation/catalog";
import { route } from "@/lib/http/api-response";
import { guardMutation } from "@/lib/http/guard-request";
import { getRequestMeta } from "@/lib/http/request-meta";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  return NextResponse.json({ category: await getCategory(await getCurrentUser(), id) });
});

export const PATCH = route(async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
  await guardMutation(request);
  const { id } = await ctx.params;
  const body = categoryUpdateSchema.parse(await request.json());
  const category = await updateCategory(await getCurrentUser(), id, {
    ...body,
    ...getRequestMeta(request),
  });
  return NextResponse.json({ category });
});
