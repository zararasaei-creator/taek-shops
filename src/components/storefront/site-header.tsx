import Link from "next/link";

import { Container } from "@/components/ui/container";
import { BrandMark, CartIcon } from "@/components/storefront/illustrations";

const link =
  "whitespace-nowrap rounded-full px-3 py-2 text-ink-soft transition-colors hover:bg-ink/5 hover:text-ink " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

/**
 * Storefront header. Presentational only: the layout decides who is signed in and how many
 * items are in the cart. The data-testid values and the exact "Cart (N)" text are relied on
 * by the existing e2e specs, so they are unchanged. One set of links serves every width —
 * on phones it wraps under the brand row and scrolls sideways instead of duplicating markup.
 */
export function SiteHeader({ signedIn, cartCount }: { signedIn: boolean; cartCount: number }) {
  return (
    <header className="sticky top-0 z-30 border-b border-ink/10 bg-cream text-ink">
      <Container>
        <nav
          aria-label="Main"
          className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 md:flex-nowrap md:py-3"
        >
          <Link
            href="/"
            className="order-1 mr-auto flex items-center gap-2.5 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand md:order-none md:mr-0"
          >
            <BrandMark className="h-8 w-8 shrink-0" />
            <span className="text-lg font-black uppercase tracking-[0.08em]">Taek Shops</span>
          </Link>

          <ul className="order-3 -mx-2 flex w-full items-center gap-1 overflow-x-auto px-2 pb-1 text-sm font-medium [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:order-none md:mx-0 md:ml-auto md:w-auto md:overflow-visible md:p-0">
            <li>
              <Link href="/#products" className={link}>
                Shop
              </Link>
            </li>
            <li>
              <Link href="/#categories" className={link}>
                Categories
              </Link>
            </li>
            <li>
              <Link href="/#about" className={link}>
                About
              </Link>
            </li>
            <li aria-hidden="true" className="mx-1 hidden h-5 w-px bg-ink/15 md:block" />
            {signedIn ? (
              <>
                <li>
                  <Link href="/account" data-testid="nav-account" className={link}>
                    Account
                  </Link>
                </li>
                <li>
                  <Link href="/account/orders" data-testid="nav-my-orders" className={link}>
                    My orders
                  </Link>
                </li>
              </>
            ) : (
              <>
                <li>
                  <Link href="/login?next=/account" data-testid="nav-sign-in" className={link}>
                    Sign in
                  </Link>
                </li>
                <li>
                  <Link href="/register" data-testid="nav-create-account" className={link}>
                    Create account
                  </Link>
                </li>
              </>
            )}
          </ul>

          <Link
            href="/cart"
            data-testid="nav-cart"
            className="order-2 inline-flex items-center gap-2 rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand md:order-none"
          >
            <CartIcon className="h-4 w-4" />
            Cart{cartCount > 0 ? ` (${cartCount})` : ""}
          </Link>
        </nav>
      </Container>
    </header>
  );
}
