import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/auth";
import { adjustInventory } from "@/server/inventory/inventory-service";
import { inventoryAdjustSchema } from "@/lib/validation/catalog";
import { route } from "@/lib/http/api-response";
import { guardMutation } from "@/lib/http/guard-request";
import { getRequestMeta } from "@/lib/http/request-meta";

export const dynamic = "force-dynamic";

/** POST /api/admin/inventory/adjust — the single controlled stock-change endpoint. */
export const POST = route(async (request: Request) => {
  await guardMutation(request);
  const body = inventoryAdjustSchema.parse(await request.json());
  const level = await adjustInventory(await getCurrentUser(), {
    ...body,
    ...getRequestMeta(request),
  });
  return NextResponse.json({ level });
});
