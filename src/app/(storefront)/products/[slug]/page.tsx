import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";

import { Container } from "@/components/ui/container";
import { getPublicProductBySlug } from "@/server/catalog/catalog-queries";
import { VariantPicker } from "@/app/(storefront)/products/[slug]/variant-picker";
import { ImageWithFallback } from "@/components/ui/image-with-fallback";

export const dynamic = "force-dynamic";

export default async function ProductPage({ params }: PageProps<"/products/[slug]">) {
  const { slug } = await params;
  const product = await getPublicProductBySlug(slug);
  if (!product) notFound();

  const primaryImage = product.images[0] ?? null;

  return (
    <Container className="py-12">
      <Link href="/" className="text-sm text-blue-600">
        ← Back to products
      </Link>
      <div className="mt-4 max-w-md">
        {primaryImage ? (
          <Image
            src={primaryImage.url}
            alt={primaryImage.altText ?? product.name}
            width={480}
            height={480}
            className="aspect-square w-full rounded-lg border border-zinc-200 object-cover dark:border-zinc-800"
          />
        ) : (
          <ImageWithFallback />
        )}
      </div>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">{product.name}</h1>
      {product.brand ? <p className="text-zinc-500">{product.brand.name}</p> : null}
      {product.description ? (
        <p className="mt-4 max-w-2xl text-zinc-600 dark:text-zinc-300">{product.description}</p>
      ) : null}

      <h2 className="mt-10 text-lg font-medium">Choose an option</h2>
      <VariantPicker variants={product.variants} />

      <p className="mt-8 text-sm">
        <Link href="/cart" className="text-blue-600">
          Go to cart →
        </Link>
      </p>
    </Container>
  );
}
