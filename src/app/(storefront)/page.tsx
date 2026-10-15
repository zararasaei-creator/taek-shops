import Link from "next/link";
import type { ComponentType, SVGProps } from "react";

import {
  BeltsArt,
  FootwearArt,
  HeroArt,
  ProtectiveArt,
  UniformArt,
} from "@/components/storefront/illustrations";
import { ProductCard } from "@/components/storefront/product-card";
import { Container } from "@/components/ui/container";
import { listPublicProducts } from "@/server/catalog/catalog-queries";

export const dynamic = "force-dynamic";

/**
 * The four category tiles. `slugs` are the catalogue category slugs each tile stands for; a tile
 * is only a link when at least one published product actually belongs to it. Tiles with nothing
 * published say so instead of pointing at an empty page — no invented listings.
 */
const CATEGORY_TILES: {
  title: string;
  blurb: string;
  slugs: string[];
  Art: ComponentType<SVGProps<SVGSVGElement>>;
}[] = [
  { title: "Uniforms", blurb: "Doboks for class and training.", slugs: ["uniforms", "student-uniforms"], Art: UniformArt },
  { title: "Footwear", blurb: "Shoes for the training floor.", slugs: ["footwear", "shoes"], Art: FootwearArt },
  { title: "Belts", blurb: "Every rank starts with one.", slugs: ["belts"], Art: BeltsArt },
  { title: "Protective Gear", blurb: "Guards and protectors for sparring.", slugs: ["protective-gear"], Art: ProtectiveArt },
];

export default async function HomePage() {
  const { products, total } = await listPublicProducts({ take: 24 });

  // Counts are only shown when the list is complete (the query is capped at 24).
  const complete = total === products.length;
  const countFor = (slugs: string[]) =>
    products.filter((p) => p.category && slugs.includes(p.category.slug)).length;

  return (
    <div className="bg-cream text-ink">
      {/* ------------------------------------------------------------ hero */}
      <section className="relative isolate overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(62rem_38rem_at_88%_-8%,rgba(200,16,46,0.12),transparent_70%)]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 opacity-60 [background:repeating-linear-gradient(135deg,transparent_0_46px,rgba(29,29,31,0.035)_46px_48px)] [mask-image:linear-gradient(to_bottom,black,transparent_85%)]"
        />
        <Container className="grid items-center gap-10 py-12 sm:py-16 lg:grid-cols-[1.05fr_0.95fr] lg:gap-14 lg:py-24">
          <div>
            <p className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-brand">
              <span aria-hidden="true" className="h-px w-8 bg-brand" />
              Taekwondo uniforms &amp; training essentials
            </p>
            <h1 className="mt-5 text-5xl font-black leading-[0.98] tracking-tight sm:text-6xl lg:text-7xl">
              Ready for your next <span className="text-brand">level.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-soft">
              Taekwondo uniforms, belts, protective gear, and training essentials, shipped across
              Canada. All prices in Canadian dollars.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <a
                href="#products"
                className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-brand px-7 py-3.5 sm:w-auto text-base font-semibold text-white shadow-lg shadow-brand/25 transition hover:bg-brand-dark focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand"
              >
                Shop the collection
                <span aria-hidden="true">→</span>
              </a>
              <a
                href="#categories"
                className="inline-flex w-full items-center justify-center rounded-full px-5 py-3.5 text-base font-semibold text-ink ring-1 sm:w-auto ring-ink/20 transition hover:bg-ink hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand"
              >
                Browse categories
              </a>
            </div>
          </div>

          <div className="relative mx-auto w-full max-w-md lg:max-w-none">
            <div
              aria-hidden="true"
              className="absolute -inset-3 -z-10 rotate-2 rounded-[2.5rem] bg-brand/15 blur-sm"
            />
            <HeroArt className="h-auto w-full rounded-[2.25rem] shadow-2xl shadow-ink/25" />
          </div>
        </Container>
      </section>

      {/* ------------------------------------------------------ categories */}
      <section id="categories" className="scroll-mt-20 py-16 sm:py-20">
        <Container>
          <div className="max-w-2xl">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand">Categories</p>
            <h2 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">Shop by category</h2>
            <p className="mt-3 text-ink-soft">
              Uniforms, footwear, belts, and protective gear. A category links to its products once
              some are listed.
            </p>
          </div>

          <ul className="mt-10 grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-4">
            {CATEGORY_TILES.map(({ title, blurb, slugs, Art }) => {
              const count = countFor(slugs);
              const available = count > 0;
              const status = available
                ? complete
                  ? `${count} ${count === 1 ? "product" : "products"} available`
                  : "Products available"
                : "No products listed yet";
              const body = (
                <>
                  <div className="flex aspect-[4/3] items-center justify-center rounded-2xl bg-cream-deep p-3 transition-colors group-hover:bg-white sm:p-5">
                    <Art className={"h-full w-full max-w-[220px] " + (available ? "" : "opacity-60 grayscale")} />
                  </div>
                  <h3 className="mt-3 text-base font-bold tracking-tight sm:mt-4 sm:text-xl">{title}</h3>
                  <p className="mt-1 text-xs text-ink-soft sm:text-sm">{blurb}</p>
                  <p
                    className={
                      "mt-3 inline-flex items-center gap-1.5 text-xs font-semibold sm:text-sm " +
                      (available ? "text-brand group-hover:text-brand-dark" : "text-ink-soft")
                    }
                  >
                    {available ? (
                      <>
                        {status}
                        <span aria-hidden="true" className="transition-transform group-hover:translate-x-1">
                          →
                        </span>
                      </>
                    ) : (
                      status
                    )}
                  </p>
                </>
              );
              return (
                <li key={title}>
                  {available ? (
                    <a
                      href="#products"
                      aria-label={`${title}: ${status}. Jump to the products.`}
                      className="group block h-full rounded-3xl bg-white p-3 ring-1 ring-ink/10 transition duration-300 hover:-translate-y-1 sm:p-4 hover:shadow-xl hover:shadow-ink/10 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand"
                    >
                      {body}
                    </a>
                  ) : (
                    <div className="group h-full rounded-3xl bg-white/60 p-3 ring-1 ring-ink/10 sm:p-4">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </Container>
      </section>

      {/* --------------------------------------------------------- products */}
      <section id="products" className="scroll-mt-20 bg-cream-deep/60 py-16 sm:py-20">
        <Container>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="max-w-2xl">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand">The collection</p>
              <h2 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">Featured products</h2>
              <p className="mt-3 text-ink-soft">Everything currently listed in the store.</p>
            </div>
          </div>

          {products.length === 0 ? (
            <p className="mt-10 rounded-3xl bg-white p-8 text-ink-soft ring-1 ring-ink/10">
              No products are available yet.
            </p>
          ) : products.length === 1 ? (
            <div className="mt-10">
              <ProductCard product={products[0]!} wide />
            </div>
          ) : (
            <ul className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {products.map((product) => (
                <li key={product.id}>
                  <ProductCard product={product} />
                </li>
              ))}
            </ul>
          )}
        </Container>
      </section>

      {/* ------------------------------------------------------------ about */}
      <section id="about" className="scroll-mt-20 py-16 sm:py-24">
        <Container className="grid items-center gap-10 lg:grid-cols-[1fr_1.1fr]">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand">About</p>
            <h2 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">About Taek Shops</h2>
          </div>
          <div>
            <p className="text-lg leading-relaxed text-ink-soft">
              Taek Shops is a Canadian online store for taekwondo uniforms, belts, protective gear,
              and training equipment. Browse the collection, add what you need to your cart, and
              check out online.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <a
                href="#products"
                className="inline-flex items-center rounded-full bg-ink px-6 py-3 text-sm font-semibold text-white transition hover:bg-brand focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand"
              >
                View the collection
              </a>
              <Link
                href="/register"
                className="inline-flex items-center rounded-full px-6 py-3 text-sm font-semibold ring-1 ring-ink/20 transition hover:bg-ink hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand"
              >
                Create an account
              </Link>
            </div>
          </div>
        </Container>
      </section>
    </div>
  );
}
