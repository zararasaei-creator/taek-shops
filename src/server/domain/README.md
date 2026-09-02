# Domain / business logic (`src/server/domain`)

Framework-agnostic business rules: pricing, cart totals, inventory transitions,
order state machine, tax/shipping orchestration. Pure functions and services that
depend on repository interfaces, not on Next.js request objects.

**Planned structure (Phase 2+):** one folder per bounded context
(`catalog/`, `inventory/`, `cart/`, `orders/`, `pricing/`), each exposing a
service module and its types.

Not implemented in Phase 1.
