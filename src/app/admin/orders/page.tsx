import Link from "next/link";
import { FulfillmentStatus, OrderStatus, PaymentStatus, UserRole } from "@prisma/client";

import { Container } from "@/components/ui/container";
import { requireRole } from "@/server/auth";
import { formatCents } from "@/server/domain/money";
import { listOrders, type OrderSort } from "@/server/orders/order-management-service";

export const dynamic = "force-dynamic";

const SORTS: { value: OrderSort; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "total_desc", label: "Total (high → low)" },
  { value: "total_asc", label: "Total (low → high)" },
];

function isOrderStatus(value: string | undefined): value is OrderStatus {
  return !!value && (Object.values(OrderStatus) as string[]).includes(value);
}
function isPaymentStatus(value: string | undefined): value is PaymentStatus {
  return !!value && (Object.values(PaymentStatus) as string[]).includes(value);
}
function isFulfillmentStatus(value: string | undefined): value is FulfillmentStatus {
  return !!value && (Object.values(FulfillmentStatus) as string[]).includes(value);
}
function isSort(value: string | undefined): value is OrderSort {
  return !!value && SORTS.some((s) => s.value === value);
}

export default async function OrdersListPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    paymentStatus?: string;
    fulfillmentStatus?: string;
    sort?: string;
    page?: string;
  }>;
}) {
  const { user } = await requireRole(UserRole.STAFF);
  const params = await searchParams;
  const page = Math.max(Number(params.page ?? "1") || 1, 1);
  const take = 25;

  const status = isOrderStatus(params.status) ? params.status : undefined;
  const paymentStatus = isPaymentStatus(params.paymentStatus) ? params.paymentStatus : undefined;
  const fulfillmentStatus = isFulfillmentStatus(params.fulfillmentStatus)
    ? params.fulfillmentStatus
    : undefined;
  const sort = isSort(params.sort) ? params.sort : "newest";

  const { orders, total } = await listOrders(user, {
    search: params.q?.trim() || undefined,
    status,
    paymentStatus,
    fulfillmentStatus,
    sort,
    skip: (page - 1) * take,
    take,
  });
  const pages = Math.max(Math.ceil(total / take), 1);

  const qs = (overrides: Record<string, string | undefined>) => {
    const next = new URLSearchParams({
      ...(params.q ? { q: params.q } : {}),
      ...(status ? { status } : {}),
      ...(paymentStatus ? { paymentStatus } : {}),
      ...(fulfillmentStatus ? { fulfillmentStatus } : {}),
      ...(sort !== "newest" ? { sort } : {}),
      ...(page > 1 ? { page: String(page) } : {}),
    });
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) next.delete(key);
      else next.set(key, value);
    }
    return `?${next.toString()}`;
  };

  return (
    <Container className="py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>

      <form className="mt-4 flex flex-wrap gap-2" method="get">
        <input
          name="q"
          defaultValue={params.q ?? ""}
          placeholder="Order number or email"
          className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <select
          name="status"
          defaultValue={status ?? ""}
          className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">Any order status</option>
          {Object.values(OrderStatus).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          name="paymentStatus"
          defaultValue={paymentStatus ?? ""}
          className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">Any payment status</option>
          {Object.values(PaymentStatus).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          name="fulfillmentStatus"
          defaultValue={fulfillmentStatus ?? ""}
          className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">Any fulfilment status</option>
          {Object.values(FulfillmentStatus).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          name="sort"
          defaultValue={sort}
          className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700"
        >
          Filter
        </button>
      </form>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800">
            <tr>
              <th className="py-2 pr-4">Order</th>
              <th className="py-2 pr-4">Date</th>
              <th className="py-2 pr-4">Customer</th>
              <th className="py-2 pr-4">Total</th>
              <th className="py-2 pr-4">Payment</th>
              <th className="py-2 pr-4">Order status</th>
              <th className="py-2 pr-4">Fulfilment</th>
            </tr>
          </thead>
          <tbody>
            {orders.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-6 text-center text-zinc-500">
                  No orders.
                </td>
              </tr>
            ) : (
              orders.map((order) => (
                <tr key={order.id} className="border-b border-zinc-100 dark:border-zinc-900">
                  <td className="py-2 pr-4">
                    <Link
                      href={`/admin/orders/${order.id}`}
                      className="font-mono text-xs font-medium text-blue-700 hover:underline dark:text-blue-400"
                    >
                      {order.orderNumber}
                    </Link>
                  </td>
                  <td className="py-2 pr-4 text-zinc-500">
                    {order.createdAt.toISOString().slice(0, 10)}
                  </td>
                  <td className="py-2 pr-4">{order.customerEmail}</td>
                  <td className="py-2 pr-4 tabular-nums">{formatCents(order.totalCents)}</td>
                  <td className="py-2 pr-4">{order.paymentStatus}</td>
                  <td className="py-2 pr-4">{order.status}</td>
                  <td className="py-2 pr-4">{order.fulfillmentStatus}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-sm text-zinc-500">
        {total} order(s){" · "}
        {pages > 1 ? (
          <>
            page {page} / {pages}{" "}
            {page > 1 ? (
              <Link className="text-blue-700" href={qs({ page: String(page - 1) })}>
                ← prev
              </Link>
            ) : null}{" "}
            {page < pages ? (
              <Link className="text-blue-700" href={qs({ page: String(page + 1) })}>
                next →
              </Link>
            ) : null}
          </>
        ) : null}
      </p>
    </Container>
  );
}
