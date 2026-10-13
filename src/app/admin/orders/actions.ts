"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import type { FulfillmentStatus, OrderStatus } from "@prisma/client";

import { getCurrentUser } from "@/server/auth";
import { isAuthError } from "@/server/auth/errors";
import { CatalogValidationError, isCatalogError } from "@/server/catalog/errors";
import { parseAmountToCents } from "@/server/domain/money";
import {
  changeOrderFulfillmentStatus,
  changeOrderStatus,
} from "@/server/orders/order-management-service";
import { reconcileRefund, requestRefund } from "@/server/orders/refund-service";

/**
 * Server actions for the admin Orders UI. Every action re-resolves the actor
 * server-side and delegates to `order-management-service.ts`, which enforces
 * authorization and transition legality — the UI is never the security
 * boundary. Failures are returned as `{ ok: false, error }` for the caller to
 * render; unexpected errors are re-thrown.
 */

export type OrderActionResult = { ok: true } | { ok: false; error: string };

async function requestMeta() {
  const h = await headers();
  return {
    ipAddress: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: h.get("user-agent"),
  };
}

async function run(fn: () => Promise<unknown>): Promise<OrderActionResult> {
  try {
    await fn();
    return { ok: true };
  } catch (error) {
    if (isCatalogError(error) || isAuthError(error)) {
      return { ok: false, error: error.publicMessage };
    }
    throw error;
  }
}

export async function changeOrderStatusAction(
  orderId: string,
  targetStatus: OrderStatus,
): Promise<OrderActionResult> {
  const actor = await getCurrentUser();
  // `applyOrderStatusTransition` (order-inventory.ts, Phase 5) records its own
  // audit event without request metadata — nothing to pass through here.
  // Cancelling a PENDING order is provider-aware (`order-cancellation.ts`):
  // any non-cancelled outcome comes back as `{ ok: false, error }` with the
  // explicit reason (paid / processing / uncertain / manual reconciliation).
  const result = await run(() => changeOrderStatus(actor, orderId, targetStatus));
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath("/admin/orders");
  return result;
}

export async function changeOrderFulfillmentStatusAction(
  orderId: string,
  targetStatus: FulfillmentStatus,
): Promise<OrderActionResult> {
  const actor = await getCurrentUser();
  const meta = await requestMeta();
  const result = await run(() => changeOrderFulfillmentStatus(actor, orderId, targetStatus, meta));
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath("/admin/orders");
  return result;
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

function str(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function requestRefundAction(
  orderId: string,
  _prev: OrderActionResult | null,
  form: FormData,
): Promise<OrderActionResult> {
  const actor = await getCurrentUser();
  const meta = await requestMeta();
  const idempotencyKey = str(form, "idempotencyKey");
  const confirmed = form.get("confirmed") === "on";

  const result = await run(async () => {
    if (!confirmed) throw new CatalogValidationError("Confirm the refund before submitting.");
    await requestRefund(
      actor,
      orderId,
      {
        amountCents: parseAmountToCents(str(form, "amount")),
        reason: str(form, "reason"),
        idempotencyKey,
      },
      meta,
    );
  });
  revalidatePath(`/admin/orders/${orderId}`);
  return result;
}

export async function reconcileRefundAction(
  orderId: string,
  refundId: string,
): Promise<OrderActionResult> {
  const actor = await getCurrentUser();
  const result = await run(() => reconcileRefund(actor, refundId));
  revalidatePath(`/admin/orders/${orderId}`);
  return result;
}
