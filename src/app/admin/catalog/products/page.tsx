import Link from "next/link";
import { ProductStatus, UserRole } from "@prisma/client";

import { Container } from "@/components/ui/container";
import { requireRole } from "@/server/auth";
import { hasPermission } from "@/server/auth/authorization";
import { listProducts } from "@/server/catalog/product-service";

export const dynamic = "force-dynamic";

export default async function ProductListPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>;
}) {
  const { user } = await requireRole(UserRole.STAFF);
  const params = await searchParams;
  const page = Math.max(Number(params.page ?? "1") || 1, 1);
  const take = 25;

  const status =
    params.status && (Object.values(ProductStatus) as string[]).includes(params.status)
      ? (params.status as ProductStatus)
      : undefined;

  const { products, total } = await listProducts(user, {
    search: params.q?.trim() || undefined,
    status,
    skip: (page - 1) * take,
    take,
  });
  const pages = Math.max(Math.ceil(total / take), 1);

  return (
    <Container className="py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Products</h1>
        {hasPermission(user, "catalog.write") ? (
          <Link
            href="/admin/catalog/products/new"
            className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            New product
          </Link>
        ) : null}
      </div>

      <form className="mt-4 flex flex-wrap gap-2" method="get">
        <input
          name="q"
          defaultValue={params.q ?? ""}
          placeholder="Search name / SKU"
          className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <select
          name="status"
          defaultValue={params.status ?? ""}
          className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">Any status</option>
          {Object.values(ProductStatus).map((s) => (
            <option key={s} value={s}>
              {s}
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
              <th className="py-2 pr-4">Name</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2 pr-4">Brand</th>
              <th className="py-2 pr-4">Category</th>
              <th className="py-2 pr-4">Variants</th>
              <th className="py-2 pr-4">Updated</th>
            </tr>
          </thead>
          <tbody>
            {products.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-6 text-center text-zinc-500">
                  No products.
                </td>
              </tr>
            ) : (
              products.map((product) => (
                <tr key={product.id} className="border-b border-zinc-100 dark:border-zinc-900">
                  <td className="py-2 pr-4">
                    <Link
                      href={`/admin/catalog/products/${product.id}`}
                      className="font-medium text-blue-700 hover:underline dark:text-blue-400"
                    >
                      {product.name}
                    </Link>
                    <div className="text-xs text-zinc-500">{product.slug}</div>
                  </td>
                  <td className="py-2 pr-4">{product.status}</td>
                  <td className="py-2 pr-4">{product.brand?.name ?? "—"}</td>
                  <td className="py-2 pr-4">{product.category?.name ?? "—"}</td>
                  <td className="py-2 pr-4">{product._count.variants}</td>
                  <td className="py-2 pr-4 text-zinc-500">
                    {product.updatedAt.toISOString().slice(0, 10)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-sm text-zinc-500">
        {total} product(s){" · "}
        {pages > 1 ? (
          <>
            page {page} / {pages}{" "}
            {page > 1 ? (
              <Link className="text-blue-700" href={`?q=${params.q ?? ""}&page=${page - 1}`}>
                ← prev
              </Link>
            ) : null}{" "}
            {page < pages ? (
              <Link className="text-blue-700" href={`?q=${params.q ?? ""}&page=${page + 1}`}>
                next →
              </Link>
            ) : null}
          </>
        ) : null}
      </p>
    </Container>
  );
}
