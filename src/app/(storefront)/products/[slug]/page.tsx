import Link from "next/link";
import { notFound } from "next/navigation";

import { Container } from "@/components/ui/container";
import { getPublicProductBySlug } from "@/server/catalog/catalog-queries";
import { formatCents } from "@/server/domain/money";
import { addToCartAction } from "@/app/(storefront)/actions";
import { StoreForm } from "@/app/(storefront)/store-form";

export const dynamic = "force-dynamic";

export default async function ProductPage({ params }: PageProps<"/products/[slug]">) {
  const { slug } = await params;
  const product = await getPublicProductBySlug(slug);
  if (!product) notFound();

  return (
    <Container className="py-12">
      <Link href="/" className="text-sm text-blue-600">
        ← Back to products
      </Link>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">{product.name}</h1>
      {product.brand ? <p className="text-zinc-500">{product.brand.name}</p> : null}
      {product.description ? (
        <p className="mt-4 max-w-2xl text-zinc-600 dark:text-zinc-300">{product.description}</p>
      ) : null}

      <h2 className="mt-10 text-lg font-medium">Choose an option</h2>
      <ul className="mt-4 flex flex-col gap-4">
        {product.variants.map((variant) => (
          <li
            key={variant.id}
            className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
            data-testid="variant-row"
          >
            <div>
              <p className="font-medium">
                {variant.options.length
                  ? variant.options.map((o) => `${o.option}: ${o.value}`).join(" · ")
                  : (variant.name ?? variant.sku)}
              </p>
              <p className="text-sm text-zinc-500">
                {formatCents(variant.priceCents)} · SKU {variant.sku}
              </p>
            </div>
            <StoreForm
              action={addToCartAction}
              submitLabel="Add to cart"
              pendingLabel="Adding…"
              variant="primary"
              className="flex items-center gap-2"
              hidden={{ variantId: variant.id, quantity: "1" }}
            />
          </li>
        ))}
      </ul>

      <p className="mt-8 text-sm">
        <Link href="/cart" className="text-blue-600">
          Go to cart →
        </Link>
      </p>
    </Container>
  );
}
