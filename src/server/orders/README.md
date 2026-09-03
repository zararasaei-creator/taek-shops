# Orders (`src/server/orders`)

Phase 5 delivers only the **inventory wiring** for the order lifecycle. Order
_creation_ (from a cart, with totals / addresses / order numbers) is Phase 6; the
full order state machine (payment, fulfilment, refunds) is Phase 8. This module
is what those phases call to keep stock correct.

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
