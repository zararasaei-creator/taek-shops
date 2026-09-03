import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/auth";
import { inventoryHealth } from "@/server/inventory/invariant";
import { route } from "@/lib/http/api-response";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/inventory/health — reconciles every `InventoryItem` against its
 * `StockMovement` ledger and reports any anomaly (counter ≠ ledger sum, negative
 * counter, reserved > on-hand). Read-only. Requires `inventory.read`.
 */
export const GET = route(async () => {
  const report = await inventoryHealth(await getCurrentUser());
  return NextResponse.json(report, { status: report.ok ? 200 : 409 });
});
