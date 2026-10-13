# Tax (`src/server/tax`)

`TaxCalculator` interface + `ConfiguredRateTaxCalculator` (Phase 6).

**The platform ships no tax rates.** They are operator data in `TaxRegion` /
`TaxRate` (the seed adds an example Ontario/HST 13% row; ADMINs maintain them
at `/admin/settings/tax` — see `src/server/settings/tax-shipping-service.ts`).

- `quote(lines, shipTo, at?) → TaxQuote` — matches a `TaxRegion` on
  `country` + `province`, falling back to a country-wide `province = ""` row.
- Active `TaxRate`s are applied in `priority` order, filtered by `taxCategory`
  (`""` = every product; otherwise it must equal the line's `Product.taxCategory`)
  and by `effectiveFrom` / `effectiveTo`.
- `compound` rates are charged on the running total (base + earlier taxes).
- `taxCents = round(taxableCents * rate)` (round half away from zero,
  `src/server/domain/money.ts#applyRate`).

The result is frozen onto `OrderItem.lineTaxCents` and `Order.taxCents` at
checkout. `getTaxCalculator()` is the swap point for a third-party adapter.
