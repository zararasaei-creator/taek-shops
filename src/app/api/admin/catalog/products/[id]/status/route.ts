import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/auth";
import { changeProductStatus } from "@/server/catalog/product-service";
import { productStatusChangeSchema } from "@/lib/validation/catalog";
import { route } from "@/lib/http/api-response";
import { guardMutation } from "@/lib/http/guard-request";
import { getRequestMeta } from "@/lib/http/request-meta";

export const dynamic = "force-dynamic";

export const POST = route(async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
  await guardMutation(request);
  const { id } = await ctx.params;
  const { status } = productStatusChangeSchema.parse(await request.json());
  const product = await changeProductStatus(
    await getCurrentUser(),
    id,
    status,
    getRequestMeta(request),
  );
  return NextResponse.json({ product });
});
