import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/server/auth";
import { createCategory, listCategories } from "@/server/catalog/category-service";
import { categoryCreateSchema } from "@/lib/validation/catalog";
import { route } from "@/lib/http/api-response";
import { guardMutation } from "@/lib/http/guard-request";
import { getRequestMeta } from "@/lib/http/request-meta";

export const dynamic = "force-dynamic";

const listQuerySchema = z.object({
  includeInactive: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

export const GET = route(async (request: Request) => {
  const actor = await getCurrentUser();
  const query = listQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
  return NextResponse.json({ categories: await listCategories(actor, query) });
});

export const POST = route(async (request: Request) => {
  await guardMutation(request);
  const body = categoryCreateSchema.parse(await request.json());
  const category = await createCategory(await getCurrentUser(), {
    ...body,
    ...getRequestMeta(request),
  });
  return NextResponse.json({ category }, { status: 201 });
});
