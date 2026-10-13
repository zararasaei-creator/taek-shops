import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Container } from "@/components/ui/container";
import { getCurrentUser } from "@/server/auth";
import { formatCents } from "@/server/domain/money";
import { isCatalogError } from "@/server/catalog/errors";
import { getMyOrderDetail } from "@/server/orders/order-queries";

export const dynamic = "force-dynamic";

export default async function MyOrderDetailPage({
  params,
}: {
  params: Promise<{ orderNumber: string }>;
}) {
  const { orderNumber } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=/account/orders/${orderNumber}`);

  let order;
  try {
    order = await getMyOrderDetail(user, orderNumber);
  } catch (error) {
    if (isCatalogError(error) && error.code === "not_found") notFound();
    throw error;
  }

  const shipping = order.addresses.find((a) => a.type === "SHIPPING");

  return (
    <Container className="py-12">
      <Link href="/account/orders" className="text-sm text-blue-600">
        ← My orders
      </Link>

      <h1 className="mt-3 text-3xl font-semibold tracking-tight" data-testid="order-number">
        {order.orderNumber}
      </h1>
      <p className="mt-2 text-zinc-600 dark:text-zinc-300">
        Placed {order.placedAt ? order.placedAt.toISOString().slice(0, 10) : "—"} · Status{" "}
        <strong data-testid="order-status">{order.status}</strong>, payment{" "}
        <strong data-testid="payment-status">{order.paymentStatus}</strong>, fulfilment{" "}
        <strong data-testid="fulfillment-status">{order.fulfillmentStatus}</strong>
      </p>
      {order.payments[0] && order.payments[0].refundedCents > 0 ? (
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300" data-testid="refund-status">
          Refunded {formatCents(order.payments[0].refundedCents)} of{" "}
          {formatCents(order.payments[0].amountCents)}
        </p>
      ) : null}

      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        <section>
          <h2 className="text-lg font-medium">Items</h2>
          <ul className="mt-3 flex flex-col gap-2 text-sm" data-testid="order-items">
            {order.items.map((item, i) => (
              <li key={i} className="flex justify-between gap-4">
                <span>
                  {item.productName}
                  {item.variantName ? ` — ${item.variantName}` : ""} × {item.quantity}
                  <span className="block text-xs text-zinc-500">
                    {formatCents(item.unitPriceCents)} each · SKU {item.sku}
                  </span>
                </span>
                <span className="tabular-nums">{formatCents(item.lineTotalCents)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-medium">Summary</h2>
          <dl className="mt-3 flex flex-col gap-1 text-sm">
            <Line label="Subtotal" value={formatCents(order.subtotalCents)} />
            {order.discountCents > 0 ? (
              <Line label="Discount" value={`−${formatCents(order.discountCents)}`} />
            ) : null}
            <Line label="Shipping" value={formatCents(order.shippingCents)} />
            <Line label="Tax" value={formatCents(order.taxCents)} />
            <Line label="Total" value={formatCents(order.totalCents)} strong />
          </dl>
          {shipping ? (
            <>
              <h3 className="mt-6 text-sm font-medium">Shipped to</h3>
              <address className="mt-1 text-sm text-zinc-600 not-italic dark:text-zinc-300">
                {shipping.firstName} {shipping.lastName}
                <br />
                {shipping.line1}
                {shipping.line2 ? (
                  <>
                    <br />
                    {shipping.line2}
                  </>
                ) : null}
                <br />
                {shipping.city}, {shipping.province} {shipping.postalCode}
                <br />
                {shipping.country}
              </address>
            </>
          ) : null}
        </section>
      </div>
    </Container>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div
      className={`flex justify-between ${strong ? "border-t border-zinc-200 pt-1 font-semibold dark:border-zinc-800" : ""}`}
    >
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
