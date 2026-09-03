import Link from "next/link";

import { Container } from "@/components/ui/container";
import { listPublicProducts } from "@/server/catalog/catalog-queries";
import { formatCents } from "@/server/domain/money";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const { products } = await listPublicProducts({ take: 24 });

  return (
    <Container className="py-12">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
        Uniforms, belts, and gear for every taekwondo journey
      </h1>
      <p className="mt-3 max-w-2xl text-zinc-600 dark:text-zinc-300">
        Shipping across Canada. All prices in Canadian dollars.
      </p>

      {products.length === 0 ? (
        <p className="mt-10 text-zinc-500">No products are available yet.</p>
      ) : (
        <ul className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((product) => {
            const { minCents, maxCents } = product.priceRange;
            return (
              <li
                key={product.id}
                className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800"
              >
                <Link href={`/products/${product.slug}`} className="block">
                  <h2 className="text-lg font-medium">{product.name}</h2>
                  {product.brand ? (
                    <p className="text-sm text-zinc-500">{product.brand.name}</p>
                  ) : null}
                  <p className="mt-2 text-sm">
                    {minCents === maxCents
                      ? formatCents(minCents)
                      : `${formatCents(minCents)} – ${formatCents(maxCents)}`}
                  </p>
                  <span className="mt-3 inline-block text-sm text-blue-600">View product →</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Container>
  );
}
