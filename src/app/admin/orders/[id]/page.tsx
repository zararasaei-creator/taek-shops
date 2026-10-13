import { notFound } from "next/navigation";
import { UserRole } from "@prisma/client";

import { Container } from "@/components/ui/container";
import { requireRole } from "@/server/auth";
import { hasPermission } from "@/server/auth/authorization";
import { NotFoundError } from "@/server/catalog/errors";
import { formatCents } from "@/server/domain/money";
import { getOrderDetail, type OrderDetail } from "@/server/orders/order-management-service";
import { computeRefundSummary } from "@/server/orders/refund-service";
import { OrderStatusButtons } from "@/app/admin/orders/[id]/order-status-buttons";
import { RefundPanel } from "@/app/admin/orders/[id]/refund-panel";

export const dynamic = "force-dynamic";

function formatTimestamp(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function optionsLabel(options: unknown): string {
  if (!Array.isArray(options)) return "";
  return options
    .filter(
      (o): o is { option: string; value: string } =>
        !!o && typeof o === "object" && "option" in o && "value" in o,
    )
    .map((o) => `${o.option}: ${o.value}`)
    .join(" / ");
}

function AddressBlock({ address }: { address: OrderDetail["addresses"][number] | undefined }) {
  if (!address) return <p className="text-sm text-zinc-500">Not on file.</p>;
  return (
    <address className="text-sm not-italic text-zinc-700 dark:text-zinc-300">
      {address.firstName} {address.lastName}
      {address.company ? <> · {address.company}</> : null}
      <br />
      {address.line1}
      {address.line2 ? <>, {address.line2}</> : null}
      <br />
      {address.city}, {address.province} {address.postalCode}
      <br />
      {address.country}
      {address.phone ? <> · {address.phone}</> : null}
    </address>
  );
}

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await requireRole(UserRole.STAFF);
  const canWrite = hasPermission(user, "order.write");

  let order;
  try {
    order = await getOrderDetail(user, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const shipping = order.addresses.find((a) => a.type === "SHIPPING");
  const billing = order.addresses.find((a) => a.type === "BILLING");

  return (
    <Container className="max-w-4xl py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{order.orderNumber}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Placed {order.placedAt ? formatTimestamp(order.placedAt) : "—"} · Created{" "}
            {formatTimestamp(order.createdAt)}
            {order.cancelledAt ? <> · Cancelled {formatTimestamp(order.cancelledAt)}</> : null}
          </p>
          <p className="mt-1 text-sm">
            <span className="font-medium">{order.status}</span> ·{" "}
            <span className="font-medium">{order.paymentStatus}</span> ·{" "}
            <span className="font-medium">{order.fulfillmentStatus}</span>
          </p>
        </div>
        {canWrite ? (
          <OrderStatusButtons
            orderId={order.id}
            status={order.status}
            paymentStatus={order.paymentStatus}
            fulfillmentStatus={order.fulfillmentStatus}
          />
        ) : null}
      </div>

      <section className="mt-8">
        <h2 className="text-lg font-semibold">Items ({order.items.length})</h2>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800">
              <tr>
                <th className="py-2 pr-4">Product</th>
                <th className="py-2 pr-4">SKU</th>
                <th className="py-2 pr-4">Qty</th>
                <th className="py-2 pr-4">Unit price</th>
                <th className="py-2 pr-4">Line total</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item) => (
                <tr key={item.id} className="border-b border-zinc-100 dark:border-zinc-900">
                  <td className="py-2 pr-4">
                    <div className="font-medium">{item.productName}</div>
                    <div className="text-xs text-zinc-500">
                      {item.variantName ?? (optionsLabel(item.optionsSnapshot) || "—")}
                    </div>
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs">{item.sku}</td>
                  <td className="py-2 pr-4">{item.quantity}</td>
                  <td className="py-2 pr-4 tabular-nums">{formatCents(item.unitPriceCents)}</td>
                  <td className="py-2 pr-4 tabular-nums">{formatCents(item.lineTotalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex flex-col items-end gap-1 text-sm">
          <div className="flex w-56 justify-between">
            <span className="text-zinc-500">Subtotal</span>
            <span className="tabular-nums">{formatCents(order.subtotalCents)}</span>
          </div>
          {order.discountCents > 0 ? (
            <div className="flex w-56 justify-between">
              <span className="text-zinc-500">Discount</span>
              <span className="tabular-nums">−{formatCents(order.discountCents)}</span>
            </div>
          ) : null}
          <div className="flex w-56 justify-between">
            <span className="text-zinc-500">Shipping</span>
            <span className="tabular-nums">{formatCents(order.shippingCents)}</span>
          </div>
          <div className="flex w-56 justify-between">
            <span className="text-zinc-500">Tax</span>
            <span className="tabular-nums">{formatCents(order.taxCents)}</span>
          </div>
          <div className="flex w-56 justify-between border-t border-zinc-200 pt-1 font-semibold dark:border-zinc-800">
            <span>Total</span>
            <span className="tabular-nums">{formatCents(order.totalCents)}</span>
          </div>
        </div>
      </section>

      <section className="mt-10 grid gap-8 sm:grid-cols-2">
        <div>
          <h2 className="text-lg font-semibold">Shipping</h2>
          <div className="mt-2">
            <AddressBlock address={shipping} />
          </div>
        </div>
        <div>
          <h2 className="text-lg font-semibold">Billing</h2>
          <div className="mt-2">
            <AddressBlock address={billing} />
          </div>
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Customer</h2>
        <p className="mt-2 text-sm">
          {order.customerEmail}
          {order.customerPhone ? <> · {order.customerPhone}</> : null}
        </p>
        {order.customerNote ? (
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
            <span className="font-medium">Note:</span> {order.customerNote}
          </p>
        ) : null}
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Payment</h2>
        {order.payments.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">No payment record yet.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800">
                <tr>
                  <th className="py-2 pr-4">Provider</th>
                  <th className="py-2 pr-4">Reference</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Amount</th>
                  <th className="py-2 pr-4">Card</th>
                  <th className="py-2 pr-4">Updated</th>
                </tr>
              </thead>
              <tbody>
                {order.payments.map((payment) => {
                  const card = payment.metadata as { brand?: string; last4?: string } | null;
                  return (
                    <tr key={payment.id} className="border-b border-zinc-100 dark:border-zinc-900">
                      <td className="py-2 pr-4">{payment.provider}</td>
                      <td className="py-2 pr-4 font-mono text-xs">
                        {payment.providerPaymentId ?? "—"}
                      </td>
                      <td className="py-2 pr-4">{payment.status}</td>
                      <td className="py-2 pr-4 tabular-nums">{formatCents(payment.amountCents)}</td>
                      <td className="py-2 pr-4">
                        {card?.brand && card?.last4 ? `${card.brand} •••• ${card.last4}` : "—"}
                      </td>
                      <td className="py-2 pr-4 text-zinc-500">{formatTimestamp(payment.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-zinc-500">
          Payment status is set only by Stripe (via the signature-verified webhook or server-side
          return-page verification) — it cannot be changed from this page.
        </p>
      </section>

      {order.payments[0] ? (
        <section className="mt-10">
          <h2 className="text-lg font-semibold">Refunds</h2>
          <RefundPanel
            orderId={order.id}
            {...computeRefundSummary(
              order.payments[0],
              order.payments[0].refunds
                .filter((r) => r.status === "PENDING")
                .reduce((sum, r) => sum + r.amountCents, 0),
            )}
            refunds={order.payments[0].refunds}
            canRequest={canWrite}
          />
        </section>
      ) : null}
    </Container>
  );
}
