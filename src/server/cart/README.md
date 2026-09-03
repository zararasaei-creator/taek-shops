# Cart (`src/server/cart`)

Guest + customer shopping carts (Phase 6).

- **`cart-cookie.ts`** — the `taek_cart` first-party `httpOnly` cookie holding an
  opaque cart token (not a credential — it only names a cart).
- **`identity.ts`** — `cartIdentity()` resolves `{ token, userId }` from the cart
  cookie + the session.
- **`cart-service.ts`**:
  - `getOrCreateCart` / `findActiveCart` — one `ACTIVE` cart per token; a
    signed-in shopper's cart also carries `userId`.
  - `getCartSummary` — **recomputes every line amount from the current
    `ProductVariant.priceCents`**. A line whose product/variant is no longer
    sellable (product not `ACTIVE`+`active`, variant inactive, non-CAD) is
    dropped and reported in `removedUnavailable`. The client never supplies a
    price.
  - `addToCart` / `updateCartItem` / `removeCartItem` — quantity is clamped to
    `MAX_CART_LINE_QUANTITY` (99); an unavailable variant is rejected.

Carts are consumed at checkout (`src/server/orders/checkout-service.ts`), which
sets `Cart.status = CONVERTED`.
