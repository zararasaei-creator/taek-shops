"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { formatCents } from "@/server/domain/money";
import {
  reconcileRefundAction,
  requestRefundAction,
  type OrderActionResult,
} from "@/app/admin/orders/actions";

export interface RefundRow {
  id: string;
  amountCents: number;
  currency: string;
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  reason: string;
  providerRefundId: string | null;
  errorMessage: string | null;
  createdAt: Date;
}

interface RefundPanelProps {
  orderId: string;
  currency: string;
  capturedCents: number;
  confirmedRefundedCents: number;
  pendingRefundedCents: number;
  remainingCents: number;
  refunds: RefundRow[];
  /** False when there's nothing to refund yet, or the caller lacks `order.write`. */
  canRequest: boolean;
}

function ReconcileButton({ orderId, refundId }: { orderId: string; refundId: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        variant="secondary"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          const result = await reconcileRefundAction(orderId, refundId);
          if (!result.ok) setError(result.error);
          setPending(false);
        }}
      >
        {pending ? "Checking…" : "Check status"}
      </Button>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </span>
  );
}

export function RefundPanel({
  orderId,
  currency,
  capturedCents,
  confirmedRefundedCents,
  pendingRefundedCents,
  remainingCents,
  refunds,
  canRequest,
}: RefundPanelProps) {
  const action = requestRefundAction.bind(null, orderId);
  const [state, formAction, pending] = useActionState<OrderActionResult | null, FormData>(
    action,
    null,
  );
  // One idempotency key per mount of this form — a double click or a retry
  // of the same in-flight submission reuses it; a fresh page load (a
  // genuinely new attempt) gets a new one.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  return (
    <div className="mt-4 flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-zinc-500">Captured</dt>
          <dd className="tabular-nums">{formatCents(capturedCents)}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Refunded (confirmed)</dt>
          <dd className="tabular-nums">{formatCents(confirmedRefundedCents)}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Refund pending</dt>
          <dd className="tabular-nums">{formatCents(pendingRefundedCents)}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Remaining refundable</dt>
          <dd className="tabular-nums font-medium">{formatCents(remainingCents)}</dd>
        </div>
      </dl>

      {refunds.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-zinc-500">
              <tr>
                <th className="py-1 pr-3">Requested</th>
                <th className="py-1 pr-3">Amount</th>
                <th className="py-1 pr-3">Status</th>
                <th className="py-1 pr-3">Reason</th>
                <th className="py-1 pr-3">Provider ref</th>
                <th className="py-1 pr-3" />
              </tr>
            </thead>
            <tbody>
              {refunds.map((r) => (
                <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-900">
                  <td className="py-1 pr-3 text-zinc-500">
                    {r.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                  </td>
                  <td className="py-1 pr-3 tabular-nums">{formatCents(r.amountCents)}</td>
                  <td className="py-1 pr-3">
                    {r.status}
                    {r.errorMessage ? (
                      <div className="text-red-600">{r.errorMessage}</div>
                    ) : null}
                  </td>
                  <td className="py-1 pr-3">{r.reason}</td>
                  <td className="py-1 pr-3 font-mono">{r.providerRefundId ?? "—"}</td>
                  <td className="py-1 pr-3">
                    {r.status === "PENDING" ? (
                      <ReconcileButton orderId={orderId} refundId={r.id} />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-zinc-500">No refunds requested yet.</p>
      )}

      {canRequest && remainingCents > 0 ? (
        <form action={formAction} className="flex flex-col gap-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">
              Refund amount ({currency})<span className="text-red-600"> *</span>
            </span>
            <input
              name="amount"
              required
              placeholder={(remainingCents / 100).toFixed(2)}
              className="w-40 rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
            />
            <span className="text-xs text-zinc-500">
              Up to {formatCents(remainingCents)} remaining.
            </span>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">
              Reason<span className="text-red-600"> *</span>
            </span>
            <textarea
              name="reason"
              required
              rows={2}
              placeholder="Customer returned the item"
              className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="confirmed" required />I confirm this refund of the
            amount above.
          </label>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? "Requesting…" : "Request refund"}
            </Button>
            {state?.ok === false ? (
              <span role="alert" className="text-sm text-red-600">
                {state.error}
              </span>
            ) : null}
            {state?.ok === true ? (
              <span role="status" className="text-sm text-green-700">
                Refund requested.
              </span>
            ) : null}
          </div>
          <p className="text-xs text-zinc-500">
            Refunding money never restocks inventory, releases a reservation, or reverses
            fulfilment — those are managed separately.
          </p>
        </form>
      ) : null}
    </div>
  );
}
