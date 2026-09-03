# Inventory (`src/server/inventory`)

The single controlled entry point for stock changes. Nothing else writes
`InventoryItem.quantityOnHand` / `quantityReserved`.

## Files

- **`inventory-lock.ts`** — `lockInventoryItem(tx, variantId)` issues
  `SELECT … FOR UPDATE OF "InventoryItem"` and returns the current counters.
  Every mutating transaction calls this **first**; concurrent writers to the same
  variant then serialize on the row lock, so an availability check and the write
  that depends on it are atomic. `movementExists(tx, key)` backs idempotent
  replay.
- **`inventory-service.ts`** — the operations:
  - **`adjustInventory(actor, input, db?)`** — the only manual mutation: `delta`
    or `setOnHand`, a required `reason`, a movement `type`, an optional
    `reference`. Transactional; locks the row; writes the counter update + one
    `StockMovement` together.
  - **`reserveStockTx` / `releaseReservationTx` / `commitReservationTx` /
    `restockTx` / `setOnHandTx`** — transaction-composable primitives the order
    flow builds on. Each takes an in-progress `tx`, locks, enforces the rules,
    appends one movement. All accept an optional `idempotencyKey`; a call whose
    key already exists is a no-op.
- **`invariant.ts`** — `reconcileAllInventory()` / `reconcileVariant()` recompute
  both counters straight from the ledger and report any disagreement. Surfaced
  read-only at `GET /api/admin/inventory/health`.

## Hard rules (never silently violated)

Enforced in `applyMovementTx` **and** by `CHECK` constraints on `InventoryItem`
(migration `20260906000000_phase5_inventory`):

- `quantityOnHand` ≥ 0
- `quantityReserved` ≥ 0
- `quantityReserved` ≤ `quantityOnHand`
- quantities are integers; `available = onHand − reserved` is derived, never stored

## Ledger invariant

`StockMovement` is append-only. Every movement carries a signed `quantityDelta`
(on-hand) **and** `reservedDelta` (reserved), so:

```
InventoryItem.quantityOnHand   == SUM(StockMovement.quantityDelta)
InventoryItem.quantityReserved == SUM(StockMovement.reservedDelta)
```

| Movement type               | quantityDelta | reservedDelta |
| --------------------------- | ------------- | ------------- |
| INITIAL / PURCHASE / RETURN | +qty          | 0             |
| ADJUSTMENT                  | ±qty          | 0             |
| RESERVATION                 | 0             | +qty          |
| RELEASE                     | 0             | −qty          |
| SALE (commit)               | −qty          | −qty          |

## Concurrency

`docs/catalog.md` § "Inventory adjustment rules" and § "Concurrency & the ledger
invariant". Verified by `tests/integration/inventory-concurrency.integration.test.ts`
(50 parallel reservations against 20 units → exactly 20 succeed, no oversell) and
`tests/integration/inventory-invariant.integration.test.ts` (the invariant holds
after every step of a 200-operation randomized sequence).
