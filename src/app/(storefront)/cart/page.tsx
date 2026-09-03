import Link from "next/link";

import { Container } from "@/components/ui/container";
import { formatCents } from "@/server/domain/money";
import { cartIdentity } from "@/server/cart/identity";
import { findActiveCart, getCartSummary } from "@/server/cart/cart-service";
import { removeFromCartAction, updateCartAction } from "@/app/(storefront)/actions";
import { StoreForm } from "@/app/(storefront)/store-form";

export const dynamic = "force-dynamic";

export default async function CartPage() {
  const cart = await findActiveCart(await cartIdentity());
  const summary = cart ? await getCartSummary(cart.id, cart.token) : null;

  return (
    <Container className="py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Your cart</h1>

      {!summary || summary.lines.length === 0 ? (
        <p className="mt-8 text-zinc-500" data-testid="cart-empty">
          Your cart is empty.{" "}
          <Link href="/" className="text-blue-600">
            Browse products →
          </Link>
        </p>
      ) : (
        <>
          {summary.removedUnavailable.length > 0 ? (
            <p role="status" className="mt-4 text-sm text-amber-700">
              Some items are no longer available and were removed:{" "}
              {summary.removedUnavailable.join(", ")}.
            </p>
          ) : null}

          <ul className="mt-8 flex flex-col gap-4" data-testid="cart-lines">
            {summary.lines.map((line) => (
              <li
                key={line.variantId}
                className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
              >
                <div className="min-w-0">
                  <p className="font-medium">{line.productName}</p>
                  <p className="text-sm text-zinc-500">
                    {line.options.length
                      ? line.options.map((o) => `${o.option}: ${o.value}`).join(" · ")
                      : (line.variantName ?? line.sku)}{" "}
                    · {formatCents(line.unitPriceCents)} each
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <span className="tabular-nums" data-testid="line-subtotal">
                    {formatCents(line.lineSubtotalCents)}
                  </span>
                  <StoreForm
                    action={updateCartAction}
                    submitLabel="Update"
                    variant="secondary"
                    className="flex items-end gap-2"
                    hidden={{ variantId: line.variantId }}
                  >
                    <label className="flex flex-col text-xs">
                      Qty
                      <input
                        name="quantity"
                        type="number"
                        min={1}
                        max={99}
                        defaultValue={line.quantity}
                        className="w-16 rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                      />
                    </label>
                  </StoreForm>
                  <StoreForm
                    action={removeFromCartAction}
                    submitLabel="Remove"
                    variant="secondary"
                    hidden={{ variantId: line.variantId }}
                  />
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-8 flex items-center justify-between border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <span className="text-lg font-medium">Subtotal</span>
            <span className="text-lg font-medium tabular-nums" data-testid="cart-subtotal">
              {formatCents(summary.subtotalCents)}
            </span>
          </div>
          <p className="mt-1 text-sm text-zinc-500">Shipping and tax are calculated at checkout.</p>

          <Link
            href="/checkout"
            className="mt-6 inline-flex items-center justify-center rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
            data-testid="to-checkout"
          >
            Proceed to checkout
          </Link>
        </>
      )}
    </Container>
  );
}
