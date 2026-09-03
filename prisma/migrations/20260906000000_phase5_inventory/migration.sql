-- Phase 5 — Inventory hardening.
--
-- 1. Ledger-back the reserved counter: `StockMovement.reservedDelta` records the
--    signed change to `InventoryItem.quantityReserved`, so both running counters
--    are now fully reconstructable from the append-only ledger.
-- 2. `StockMovement.idempotencyKey` + unique index: order-lifecycle operations
--    (reserve / commit / release / restock) pass a deterministic key so a replayed
--    operation is a no-op instead of a duplicate movement.
-- 3. CHECK constraints on `InventoryItem`: a database-level backstop for the
--    invariants the inventory service already enforces in application code
--    (on-hand never negative, reserved never negative, reserved never exceeds
--    on-hand). Prisma has no CHECK syntax, so these are raw DDL; they are
--    documented in prisma/schema.prisma next to the model.

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "reservedDelta" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "StockMovement_idempotencyKey_key" ON "StockMovement"("idempotencyKey");

-- No backfill: pre-Phase-5 RESERVATION/RELEASE movements were written with
-- quantityDelta = 0 and carried no structured quantity, so reservedDelta stays 0
-- for them. Any InventoryItem whose quantityReserved > 0 at migration time would
-- not reconcile against the reservedDelta ledger until its reservations are
-- released/committed through the Phase 5 primitives. No such rows exist in any
-- seeded or live environment (verified in the Phase 5 pre-flight).

-- CHECK constraints (database-level backstop for the inventory rules).
ALTER TABLE "InventoryItem"
  ADD CONSTRAINT "InventoryItem_quantityOnHand_nonnegative" CHECK ("quantityOnHand" >= 0),
  ADD CONSTRAINT "InventoryItem_quantityReserved_nonnegative" CHECK ("quantityReserved" >= 0),
  ADD CONSTRAINT "InventoryItem_reserved_not_over_on_hand" CHECK ("quantityReserved" <= "quantityOnHand");
