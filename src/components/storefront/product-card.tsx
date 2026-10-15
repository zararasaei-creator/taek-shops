import Image from "next/image";
import Link from "next/link";

import type { PublicProduct } from "@/server/catalog/catalog-queries";
import { formatCents } from "@/server/domain/money";

/**
 * Shown when a product has no photo yet. Deliberately NOT a stock or generated picture: a real
 * product must only ever be represented by its own photo, so this says so plainly.
 */
export function ProductImageFallback() {
  return (
    <div
      role="img"
      aria-label="No image available"
      className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[repeating-linear-gradient(135deg,#f1ebe0_0_14px,#f7f2e9_14px_28px)] text-ink-soft"
    >
      <svg viewBox="0 0 24 24" className="h-7 w-7 opacity-50" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2.5" />
        <circle cx="9" cy="10.5" r="1.6" />
        <path d="m4 17 5-4.5 3.5 3 3-2.5L20 16" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="text-xs font-medium uppercase tracking-[0.14em]">Photo not added yet</span>
    </div>
  );
}

/** A catalogue product from the existing published-product query. `wide` = single-product layout. */
export function ProductCard({ product, wide = false }: { product: PublicProduct; wide?: boolean }) {
  const { minCents, maxCents } = product.priceRange;
  const primaryImage = product.images[0] ?? null;
  const price =
    minCents === maxCents ? formatCents(minCents) : `${formatCents(minCents)} – ${formatCents(maxCents)}`;

  return (
    <Link
      href={`/products/${product.slug}`}
      className={
        "group block rounded-3xl bg-white p-4 ring-1 ring-ink/10 transition duration-300 hover:-translate-y-1 hover:shadow-xl hover:shadow-ink/10 " +
        "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand " +
        (wide ? "grid items-center gap-6 sm:p-6 md:grid-cols-2 md:gap-10" : "")
      }
    >
      <div
        className={
          "relative overflow-hidden rounded-2xl bg-cream-deep " +
          (wide ? "aspect-[4/3] md:aspect-square" : "aspect-[4/5]")
        }
      >
        {primaryImage ? (
          <Image
            src={primaryImage.url}
            alt={primaryImage.altText ?? product.name}
            fill
            sizes={wide ? "(min-width: 768px) 40vw, 90vw" : "(min-width: 1024px) 30vw, (min-width: 640px) 45vw, 90vw"}
            className="object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <ProductImageFallback />
        )}
      </div>

      <div className={wide ? "px-1 pb-2 md:pb-0" : "px-1 pb-1 pt-4"}>
        {product.brand ? (
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand">
            {product.brand.name}
          </p>
        ) : null}
        <h3 className={(wide ? "text-3xl sm:text-4xl " : "text-lg ") + "mt-1 font-bold leading-tight tracking-tight text-ink"}>
          {product.name}
        </h3>
        <p className={(wide ? "text-xl " : "text-base ") + "mt-2 font-semibold text-ink"}>{price}</p>
        <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-brand group-hover:text-brand-dark">
          View product
          <span aria-hidden="true" className="transition-transform group-hover:translate-x-1">
            →
          </span>
        </span>
      </div>
    </Link>
  );
}
