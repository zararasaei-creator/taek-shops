import Link from "next/link";
import { redirect } from "next/navigation";

import { Container } from "@/components/ui/container";
import { getCurrentUser } from "@/server/auth";
import { formatCents } from "@/server/domain/money";
import { listMyOrders } from "@/server/orders/order-queries";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 10;

export default async function MyOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/account/orders");

  const params = await searchParams;
  const page = Math.max(Number(params.page ?? "1") || 1, 1);

  const { orders, total } = await listMyOrders(user, {
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
  });
  const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1);

  return (
    <Container className="py-12">
      <h1 className="text-3xl font-semibold tracking-tight">My orders</h1>

      {orders.length === 0 ? (
        <div className="mt-8 rounded-lg border border-zinc-200 p-8 text-center dark:border-zinc-800">
          <p className="text-zinc-600 dark:text-zinc-300" data-testid="orders-empty">
            You haven&apos;t placed any orders yet.
          </p>
          <Link href="/" className="mt-3 inline-block text-sm text-blue-600">
            Start shopping →
          </Link>
        </div>
      ) : (
        <>
          <div className="mt-6 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800">
                <tr>
                  <th className="py-2 pr-4">Order</th>
                  <th className="py-2 pr-4">Date</th>
                  <th className="py-2 pr-4">Total</th>
                  <th className="py-2 pr-4">Payment</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Fulfilment</th>
                </tr>
              </thead>
              <tbody data-testid="orders-list">
                {orders.map((order) => (
                  <tr key={order.id} className="border-b border-zinc-100 dark:border-zinc-900">
                    <td className="py-2 pr-4">
                      <Link
                        href={`/account/orders/${order.orderNumber}`}
                        className="font-mono text-xs font-medium text-blue-700 hover:underline dark:text-blue-400"
                      >
                        {order.orderNumber}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 text-zinc-500">
                      {order.createdAt.toISOString().slice(0, 10)}
                    </td>
                    <td className="py-2 pr-4 tabular-nums">{formatCents(order.totalCents)}</td>
                    <td className="py-2 pr-4">{order.paymentStatus}</td>
                    <td className="py-2 pr-4">{order.status}</td>
                    <td className="py-2 pr-4">{order.fulfillmentStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-4 text-sm text-zinc-500">
            {total} order(s){" · "}
            {pages > 1 ? (
              <>
                page {page} / {pages}{" "}
                {page > 1 ? (
                  <Link className="text-blue-700" href={`?page=${page - 1}`}>
                    ← prev
                  </Link>
                ) : null}{" "}
                {page < pages ? (
                  <Link className="text-blue-700" href={`?page=${page + 1}`}>
                    next →
                  </Link>
                ) : null}
              </>
            ) : null}
          </p>
        </>
      )}
    </Container>
  );
}
