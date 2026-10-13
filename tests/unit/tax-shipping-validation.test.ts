// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  percentSchema,
  shippingMethodCreateSchema,
  taxRateCreateSchema,
  taxRegionCreateSchema,
} from "@/lib/validation/tax-shipping";

describe("percentSchema (rates are percents, never defaults)", () => {
  it.each(["0", "13", "9.975", "100", "5.0001"])("accepts %s", (v) => {
    expect(percentSchema.safeParse(v).success).toBe(true);
  });
  it.each(["", " ", "abc", "-1", "100.01", "13.12345", "1,5", "%13", "1e2"])("rejects %j", (v) => {
    expect(percentSchema.safeParse(v).success).toBe(false);
  });
});

describe("taxRateCreateSchema dates", () => {
  const base = { regionId: "r", name: "T", ratePercent: "5", priority: "0", compound: false, active: true };
  it("treats blank as no bound and parses UTC day edges", () => {
    const parsed = taxRateCreateSchema.parse({ ...base, effectiveFrom: "2026-01-31", effectiveTo: "" });
    expect(parsed.effectiveFrom?.toISOString()).toBe("2026-01-31T00:00:00.000Z");
    expect(parsed.effectiveTo).toBeNull();
    const to = taxRateCreateSchema.parse({ ...base, effectiveTo: "2026-02-28" });
    expect(to.effectiveTo?.toISOString()).toBe("2026-02-28T23:59:59.999Z");
  });
  it("rejects calendar overflow instead of silently rolling it over", () => {
    expect(taxRateCreateSchema.safeParse({ ...base, effectiveFrom: "2026-02-30" }).success).toBe(false);
    expect(taxRateCreateSchema.safeParse({ ...base, effectiveFrom: "2026-13-01" }).success).toBe(false);
  });
});

describe("shippingMethodCreateSchema money", () => {
  const base = { zoneId: "z", name: "M", sortOrder: "0", active: true };
  it("converts dollars to integer cents and blank threshold to null", () => {
    const parsed = shippingMethodCreateSchema.parse({ ...base, flatRateCents: "12.5", freeShippingThresholdCents: "" });
    expect(parsed.flatRateCents).toBe(1250);
    expect(parsed.freeShippingThresholdCents).toBeNull();
    expect(shippingMethodCreateSchema.parse({ ...base, flatRateCents: "$1,000.00", freeShippingThresholdCents: "150" }))
      .toMatchObject({ flatRateCents: 100000, freeShippingThresholdCents: 15000 });
  });
  it("has no default price: blank/garbage/negative are rejected; 0.00 is allowed only when typed", () => {
    for (const bad of ["", "   ", "x", "-1", "1.234"]) {
      expect(shippingMethodCreateSchema.safeParse({ ...base, flatRateCents: bad }).success).toBe(false);
    }
    expect(shippingMethodCreateSchema.safeParse({ ...base }).success).toBe(false); // missing entirely
    expect(shippingMethodCreateSchema.parse({ ...base, flatRateCents: "0.00" }).flatRateCents).toBe(0);
  });
});

describe("taxRegionCreateSchema", () => {
  it("requires an explicit province or country-wide choice", () => {
    expect(taxRegionCreateSchema.safeParse({ name: "X", province: "ON" }).success).toBe(true);
    expect(taxRegionCreateSchema.safeParse({ name: "X", province: "" }).success).toBe(true);
    expect(taxRegionCreateSchema.safeParse({ name: "X", province: "__choose" }).success).toBe(false);
    expect(taxRegionCreateSchema.safeParse({ name: "X", province: "ZZ" }).success).toBe(false);
    expect(taxRegionCreateSchema.safeParse({ name: "X" }).success).toBe(false);
  });
});
