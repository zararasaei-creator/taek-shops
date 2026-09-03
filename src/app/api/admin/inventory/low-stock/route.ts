import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/auth";
import { listLowStock } from "@/server/inventory/inventory-service";
import { route } from "@/lib/http/api-response";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  return NextResponse.json({ items: await listLowStock(await getCurrentUser()) });
});
