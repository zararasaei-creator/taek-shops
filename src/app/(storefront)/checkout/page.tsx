import { redirect } from "next/navigation";

import { Container } from "@/components/ui/container";
import { cartIdentity } from "@/server/cart/identity";
import { findActiveCart, getCartSummary } from "@/server/cart/cart-service";
import { quoteCheckout } from "@/server/orders/checkout-service";
import { CheckoutForm } from "@/app/(storefront)/checkout/checkout-form";

export const dynamic = "force-dynamic";

export default async function CheckoutPage() {
  const identity = await cartIdentity();
  const cart = await findActiveCart(identity);
  const summary = cart ? await getCartSummary(cart.id, cart.token) : null;

  if (!summary || summary.lines.length === 0) {
    redirect("/cart");
  }

  // Seed the form with a quote for a representative province; the client
  // refreshes it (server-recomputed) as the shopper picks a province / method.
  const initialQuote = await quoteCheckout(identity, { province: "ON" });
  if (!initialQuote) redirect("/cart");

  return (
    <Container className="py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Checkout</h1>
      <CheckoutForm initialQuote={initialQuote} />
    </Container>
  );
}
