import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/auth";
import { getProductDetail, updateProduct } from "@/server/catalog/product-service";
import { productUpdateSchema } from "@/lib/validation/catalog";
import { route } from "@/lib/http/api-response";
import { guardMutation } from "@/lib/http/guard-request";
import { getRequestMeta } from "@/lib/http/request-meta";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const product = await getProductDetail(await getCurrentUser(), id);
  return NextResponse.json({ product });
});

export const PATCH = route(async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
  await guardMutation(request);
  const { id } = await ctx.params;
  const body = productUpdateSchema.parse(await request.json());
  const product = await updateProduct(await getCurrentUser(), id, {
    ...body,
    ...getRequestMeta(request),
  });
  return NextResponse.json({ product });
});
