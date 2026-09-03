# Orders (`src/server/orders`)

- **Phase 5** — `order-inventory.ts`: the inventory wiring for the order
  lifecycle (below).
- **Phase 6** — `checkout-service.ts`: turn a cart into a `PENDING` order.
- The full order state machine (payment, fulfilment, refunds) is Phase 8.

## Checkout (`checkout-service.ts`, Phase 6)

`quoteCheckout(identity, { province, shippingMethodId })` — a read-only,
server-recomputed quote for the review step (subtotal, shipping options, tax,
total). No writes.

`placeOrder(identity, input, meta)` — **one transaction**:

1. recompute every line price from the current catalogue, shipping from the
   configured `ShippingMethod`, and tax from the configured `TaxRegion`/`TaxRate`
   (`src/server/tax`, `src/server/shipping`) — **the client cannot influence any
   amount**;
2. create the `Order` (`PENDING` / `UNPAID`) + `OrderItem` snapshots +
   `OrderAddress` (shipping & billing), freezing `subtotalCents`,
   `shippingCents`, `taxCents`, `totalCents`;
3. reserve stock for every line via `reserveStockTx` (Phase 5 — row-locked,
   deterministic lock order), so an under-stocked line rolls the whole order
   back;
4. set `Cart.status = CONVERTED`; emit `order.placed`.

Idempotent on the cart (`Order.cartId` is unique): replaying `placeOrder`
returns the order already placed and reserves stock once. Payment is Phase 7 —
the order stays `PENDING`.

## Inventory wiring (`order-inventory.ts`, Phase 5)

## `order-inventory.ts`

Four operations, each built from the `*Tx` primitives in
`src/server/inventory/inventory-service.ts`:

| Function                            | When                            | Effect                         |
| ----------------------------------- | ------------------------------- | ------------------------------ |
| `reserveOrderStock(actor, orderId)` | order placed (PENDING)          | reserve every line             |
| `commitOrderStock(actor, orderId)`  | payment confirmed               | commit the reservations (SALE) |
| `releaseOrderStock(actor, orderId)` | cancelled before commit         | release the reservations       |
| `restockOrderStock(actor, orderId)` | cancelled/refunded after commit | return units to on-hand        |

`applyOrderStatusTransition(actor, orderId, targetStatus)` validates the
`OrderStatus` transition against `ORDER_STATUS_TRANSITIONS`, applies the matching
inventory effect (`inventoryEffectForTransition`), and persists the new status +
`placedAt` / `cancelledAt` — **all in one transaction**.

```
PENDING ──confirm──▶ CONFIRMED ──▶ PROCESSING ──▶ COMPLETED
   │                     │              │
   └──── cancel ─────────┴──────────────┴────▶ CANCELLED
 (release)            (restock)      (restock)
```

### Guarantees

- **Atomic** — all lines of an operation run in one `$transaction`; any failure
  rolls the whole operation back (no partial reservation).
- **Idempotent** — each line carries `order:<id>:<op>:<variantId>` as the
  `StockMovement.idempotencyKey`; replaying an operation (retried webhook,
  double-click) is a no-op.
- **Deadlock-free** — lines are locked in ascending `variantId` order.
- **No overselling** — reservations go through the `FOR UPDATE` row lock and
  re-check availability against freshly committed data.
- **Authorized** — every operation requires the `order.write` permission
  (MANAGER+).

Covered by `tests/integration/order-inventory.integration.test.ts` and
`tests/unit/order-inventory.test.ts`.
