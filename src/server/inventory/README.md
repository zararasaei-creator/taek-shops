# Inventory (`src/server/inventory`)

The single controlled entry point for stock changes. Nothing else writes
`InventoryItem.quantityOnHand` / `quantityReserved`.

- **`adjustInventory(actor, input, db?)`** — the only manual mutation: `delta`
  or `setOnHand`, a required `reason`, a movement `type`, an optional
  `reference`. Transactional (counter update + `StockMovement` together).
- **Hard rules:** on-hand never negative; on-hand never below reserved;
  quantities are integers; `available` is derived, not stored. Every change is
  audited.
- **Order-flow primitives** (`reserveStockTx` / `releaseReservationTx` /
  `commitReservationTx` / `restockTx` / `setOnHandTx`) — transaction-composable,
  ready for the future order lifecycle. Not yet wired to orders.

See `docs/catalog.md` § "Inventory adjustment rules".
