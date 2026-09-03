import Link from "next/link";
import { notFound } from "next/navigation";

import { Container } from "@/components/ui/container";
import { formatCents } from "@/server/domain/money";
import { getCurrentUser } from "@/server/auth";
import { isCatalogError } from "@/server/catalog/errors";
import { getOrderForConfirmation } from "@/server/orders/order-queries";
import { remembersOrder } from "@/server/orders/order-confirmation-cookie";

export const dynamic = "force-dynamic";

export default async function ConfirmationPage({
  params,
}: PageProps<"/checkout/confirmation/[orderNumber]">) {
  const { orderNumber } = await params;
  const [user, justPlaced] = await Promise.all([getCurrentUser(), remembersOrder(orderNumber)]);

  let order;
  try {
    order = await getOrderForConfirmation(orderNumber, { user, justPlaced });
  } catch (error) {
    if (isCatalogError(error) && error.code === "not_found") notFound();
    throw error;
  }

  const shipping = order.addresses.find((a) => a.type === "SHIPPING");

  return (
    <Container className="py-12">
      <p className="text-sm text-green-700" data-testid="order-status">
        Order {order.status.toLowerCase()}
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Thank you for your order</h1>
      <p className="mt-2 text-zinc-600 dark:text-zinc-300">
        Order number <strong data-testid="order-number">{order.orderNumber}</strong>. A payment step
        will be added in a later release; your order is currently <strong>{order.status}</strong>.
      </p>

      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        <section>
          <h2 className="text-lg font-medium">Items</h2>
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            {order.items.map((item, i) => (
              <li key={i} className="flex justify-between gap-4">
                <span>
                  {item.productName}
                  {item.variantName ? ` — ${item.variantName}` : ""} × {item.quantity}
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
            <Line label="Shipping" value={formatCents(order.shippingCents)} />
            <Line label="Tax" value={formatCents(order.taxCents)} />
            <Line label="Total" value={formatCents(order.totalCents)} strong />
          </dl>
          {shipping ? (
            <>
              <h3 className="mt-6 text-sm font-medium">Ships to</h3>
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

      <Link href="/" className="mt-10 inline-block text-sm text-blue-600">
        Continue shopping →
      </Link>
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
