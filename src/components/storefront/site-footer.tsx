import Link from "next/link";

import { Container } from "@/components/ui/container";
import { BrandMark } from "@/components/storefront/illustrations";

const link =
  "rounded text-sm text-white/70 transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

export function SiteFooter({ signedIn }: { signedIn: boolean }) {
  return (
    <footer className="bg-ink text-white">
      <Container className="py-12">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr]">
          <div>
            <div className="flex items-center gap-2.5">
              <BrandMark className="h-8 w-8" />
              <span className="text-lg font-black uppercase tracking-[0.08em]">Taek Shops</span>
            </div>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-white/70">
              A Canadian online store for taekwondo uniforms, belts, protective gear, and training
              equipment.
            </p>
          </div>

          <nav aria-label="Shop">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/50">Shop</p>
            <ul className="mt-4 space-y-2.5">
              <li>
                <Link href="/#products" className={link}>
                  Featured products
                </Link>
              </li>
              <li>
                <Link href="/#categories" className={link}>
                  Categories
                </Link>
              </li>
              <li>
                <Link href="/cart" className={link}>
                  Cart
                </Link>
              </li>
            </ul>
          </nav>

          <nav aria-label="Account">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/50">Your account</p>
            <ul className="mt-4 space-y-2.5">
              {signedIn ? (
                <>
                  <li>
                    <Link href="/account" className={link}>
                      Account
                    </Link>
                  </li>
                  <li>
                    <Link href="/account/orders" className={link}>
                      My orders
                    </Link>
                  </li>
                </>
              ) : (
                <>
                  <li>
                    <Link href="/login?next=/account" className={link}>
                      Sign in
                    </Link>
                  </li>
                  <li>
                    <Link href="/register" className={link}>
                      Create account
                    </Link>
                  </li>
                </>
              )}
            </ul>
          </nav>
        </div>

        <p className="mt-10 border-t border-white/10 pt-6 text-sm text-white/50">
          &copy; {new Date().getFullYear()} Taek Shops. All prices in Canadian dollars.
        </p>
      </Container>
    </footer>
  );
}
