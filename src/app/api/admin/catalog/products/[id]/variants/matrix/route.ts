import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/auth";
import { generateVariantMatrix } from "@/server/catalog/variant-service";
import { matrixGenerateSchema } from "@/lib/validation/catalog";
import { route } from "@/lib/http/api-response";
import { guardMutation } from "@/lib/http/guard-request";
import { getRequestMeta } from "@/lib/http/request-meta";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/catalog/products/:id/variants/matrix — bulk-create variants
 * from the admin Variant Matrix Generator. Every cell is created atomically
 * (one transaction; all-or-nothing) via the same `createVariantTx` path a
 * single variant create uses.
 */
export const POST = route(async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
  await guardMutation(request);
  const { id } = await ctx.params;
  const body = matrixGenerateSchema.parse(await request.json());
  const variants = await generateVariantMatrix(await getCurrentUser(), id, {
    ...body,
    ...getRequestMeta(request),
  });
  return NextResponse.json({ variants }, { status: 201 });
});
