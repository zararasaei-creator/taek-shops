"use client";

import { useState, useTransition } from "react";
import { FulfillmentStatus, OrderStatus } from "@prisma/client";

import { Button } from "@/components/ui/button";
import {
  changeOrderFulfillmentStatusAction,
  changeOrderStatusAction,
} from "@/app/admin/orders/actions";

/**
 * Admin-allowed order-status targets, mirrored from
 * `ADMIN_ORDER_STATUS_TRANSITIONS` in `order-management-service.ts` — kept in
 * sync manually since one is a client-safe label map and the other is the
 * server-enforced source of truth. `PENDING → CONFIRMED` is intentionally
 * absent: an order is only ever confirmed by a successful Stripe payment.
 */
const ORDER_STATUS_TARGETS: Record<OrderStatus, { label: string; to: OrderStatus }[]> = {
  PENDING: [{ label: "Cancel order", to: OrderStatus.CANCELLED }],
  CONFIRMED: [
    { label: "Start processing", to: OrderStatus.PROCESSING },
    { label: "Cancel order", to: OrderStatus.CANCELLED },
  ],
  PROCESSING: [
    { label: "Mark completed", to: OrderStatus.COMPLETED },
    { label: "Cancel order", to: OrderStatus.CANCELLED },
  ],
  COMPLETED: [],
  CANCELLED: [],
};

const FULFILLMENT_TARGETS: Record<FulfillmentStatus, { label: string; to: FulfillmentStatus }[]> = {
  UNFULFILLED: [
    { label: "Mark partially shipped", to: FulfillmentStatus.PARTIALLY_FULFILLED },
    { label: "Mark shipped", to: FulfillmentStatus.FULFILLED },
  ],
  PARTIALLY_FULFILLED: [{ label: "Mark shipped", to: FulfillmentStatus.FULFILLED }],
  FULFILLED: [{ label: "Mark returned", to: FulfillmentStatus.RETURNED }],
  RETURNED: [],
};

export function OrderStatusButtons({
  orderId,
  status,
  paymentStatus,
  fulfillmentStatus,
}: {
  orderId: string;
  status: OrderStatus;
  paymentStatus: string;
  fulfillmentStatus: FulfillmentStatus;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const orderTargets = ORDER_STATUS_TARGETS[status];
  const fulfillmentTargets = paymentStatus === "PAID" ? FULFILLMENT_TARGETS[fulfillmentStatus] : [];

  return (
    <div className="flex flex-col gap-3">
      {orderTargets.length > 0 ? (
        <div>
          <div className="text-xs font-medium text-zinc-500 uppercase">Order status</div>
          <div className="mt-1 flex flex-wrap gap-2">
            {orderTargets.map((target) => (
              <Button
                key={target.to}
                variant="secondary"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    setError(null);
                    const result = await changeOrderStatusAction(orderId, target.to);
                    if (!result.ok) setError(result.error);
                  })
                }
              >
                {target.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {fulfillmentTargets.length > 0 ? (
        <div>
          <div className="text-xs font-medium text-zinc-500 uppercase">Fulfilment</div>
          <div className="mt-1 flex flex-wrap gap-2">
            {fulfillmentTargets.map((target) => (
              <Button
                key={target.to}
                variant="secondary"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    setError(null);
                    const result = await changeOrderFulfillmentStatusAction(orderId, target.to);
                    if (!result.ok) setError(result.error);
                  })
                }
              >
                {target.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {error ? (
        <span role="alert" className="text-xs text-red-600">
          {error}
        </span>
      ) : null}
    </div>
  );
}
