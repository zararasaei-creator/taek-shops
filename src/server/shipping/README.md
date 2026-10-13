# Shipping (`src/server/shipping`)

`ShippingRateProvider` interface + `FlatRateShippingProvider` (Phase 6).

**No shipping prices in code.** They are operator data in `ShippingZone`,
`ShippingZoneRegion`, and `ShippingMethod` (the seed adds an example
"Canada / Standard" $12 method with free shipping over $150; ADMINs maintain
them at `/admin/settings/shipping` — see `src/server/settings/tax-shipping-service.ts`).

- `rates(parcel, shipFrom, shipTo) → ShippingOption[]` — every active
  `ShippingMethod` whose zone has a `ShippingZoneRegion` matching the
  destination `country` + `province` (or a country-wide `province = ""`).
- `freeShippingThresholdCents`, when set and met by `parcel.subtotalCents`,
  zeroes the option price (`free: true`).
- `parcel.weightGrams` comes from `ProductVariant.weightGrams`; the flat-rate
  implementation does not use it, but the interface carries it for carrier
  adapters.

The chosen option's `priceCents` is frozen onto `Order.shippingCents` at
checkout. `getShippingProvider()` is the swap point for a carrier-API adapter.
