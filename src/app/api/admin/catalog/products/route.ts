import { NextResponse } from "next/server";
import { z } from "zod";
import { ProductStatus } from "@prisma/client";

import { getCurrentUser } from "@/server/auth";
import { createProduct, listProducts } from "@/server/catalog/product-service";
import { productCreateSchema, variantCreateSchema } from "@/lib/validation/catalog";
import { route } from "@/lib/http/api-response";
import { guardMutation } from "@/lib/http/guard-request";
import { getRequestMeta } from "@/lib/http/request-meta";

export const dynamic = "force-dynamic";

const listQuerySchema = z.object({
  skip: z.coerce.number().int().min(0).default(0),
  take: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().trim().max(200).optional(),
  status: z.enum(ProductStatus).optional(),
  brandId: z.string().min(1).optional(),
  categoryId: z.string().min(1).optional(),
});

export const GET = route(async (request: Request) => {
  const actor = await getCurrentUser();
  const query = listQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
  return NextResponse.json(await listProducts(actor, query));
});

const createBodySchema = productCreateSchema.extend({
  defaultVariant: variantCreateSchema.optional(),
});

export const POST = route(async (request: Request) => {
  await guardMutation(request);
  const actor = await getCurrentUser();
  const body = createBodySchema.parse(await request.json());
  const product = await createProduct(actor, { ...body, ...getRequestMeta(request) });
  return NextResponse.json({ product }, { status: 201 });
});
