import { SiteFooter } from "@/components/storefront/site-footer";
import { SiteHeader } from "@/components/storefront/site-header";
import { getCurrentUser } from "@/server/auth";
import { cartIdentity } from "@/server/cart/identity";
import { findActiveCart, getCartSummary } from "@/server/cart/cart-service";

export const dynamic = "force-dynamic";

async function cartItemCount(): Promise<number> {
  const cart = await findActiveCart(await cartIdentity());
  if (!cart) return 0;
  const summary = await getCartSummary(cart.id, cart.token);
  return summary.itemCount;
}

export default async function StorefrontLayout({ children }: LayoutProps<"/">) {
  const [count, user] = await Promise.all([cartItemCount(), getCurrentUser()]);
  const signedIn = Boolean(user);

  return (
    <div className="flex min-h-full flex-col">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-ink focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
      >
        Skip to content
      </a>
      <SiteHeader signedIn={signedIn} cartCount={count} />
      <main id="main-content" className="flex-1">
        {children}
      </main>
      <SiteFooter signedIn={signedIn} />
    </div>
  );
}
