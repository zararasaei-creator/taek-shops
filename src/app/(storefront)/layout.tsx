import Link from "next/link";

import { Container } from "@/components/ui/container";
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
  const count = await cartItemCount();

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-zinc-200 dark:border-zinc-800">
        <Container as="nav" className="flex h-16 items-center justify-between">
          <Link href="/" className="text-lg font-semibold tracking-tight">
            Taek Shops
          </Link>
          <Link href="/cart" className="text-sm" data-testid="nav-cart">
            Cart{count > 0 ? ` (${count})` : ""}
          </Link>
        </Container>
      </header>
      <main id="main-content" className="flex-1">
        {children}
      </main>
      <footer className="border-t border-zinc-200 py-6 text-sm text-zinc-500 dark:border-zinc-800">
        <Container>
          &copy; {new Date().getFullYear()} Taek Shops. All prices in Canadian dollars.
        </Container>
      </footer>
    </div>
  );
}
