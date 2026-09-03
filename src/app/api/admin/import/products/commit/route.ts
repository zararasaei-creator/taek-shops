import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/server/auth";
import { commitImport } from "@/server/import/product-import-service";
import { route } from "@/lib/http/api-response";
import { guardMutation } from "@/lib/http/guard-request";
import { getRequestMeta } from "@/lib/http/request-meta";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ importJobId: z.string().min(1) });

/** POST /api/admin/import/products/commit — apply a previously validated import. */
export const POST = route(async (request: Request) => {
  await guardMutation(request);
  const actor = await getCurrentUser();
  const { importJobId } = bodySchema.parse(await request.json());
  const result = await commitImport(actor, importJobId, getRequestMeta(request));
  return NextResponse.json(result);
});
