import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/server/auth";
import { createBrand, listBrands } from "@/server/catalog/brand-service";
import { brandCreateSchema } from "@/lib/validation/catalog";
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
  return NextResponse.json({ brands: await listBrands(actor, query) });
});

export const POST = route(async (request: Request) => {
  await guardMutation(request);
  const body = brandCreateSchema.parse(await request.json());
  const brand = await createBrand(await getCurrentUser(), { ...body, ...getRequestMeta(request) });
  return NextResponse.json({ brand }, { status: 201 });
});
