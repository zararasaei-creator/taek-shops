// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";

import { ConfiguredRateTaxCalculator } from "@/server/tax/tax-calculator";
import { createMockPrisma, type MockPrisma } from "./helpers/mock-prisma";

const ON = { country: "CA", province: "ON" };

function withRegion(db: MockPrisma, region: unknown) {
  db.taxRegion.findFirst.mockResolvedValue(region as never);
}

describe("ConfiguredRateTaxCalculator", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
  });

  it("applies a single rate to each line and rounds to cents", async () => {
    withRegion(db, {
      name: "Ontario",
      rates: [{ name: "HST", rate: "0.130000", taxCategory: "", compound: false }],
    });
    const calc = new ConfiguredRateTaxCalculator(db);
    const quote = await calc.quote(
      [
        { ref: "a", taxableCents: 10000, taxCategory: null },
        { ref: "b", taxableCents: 999, taxCategory: "standard" },
      ],
      ON,
    );
    expect(quote.regionName).toBe("Ontario");
    expect(quote.lines[0]).toMatchObject({ ref: "a", taxCents: 1300 });
    expect(quote.lines[1]).toMatchObject({ ref: "b", taxCents: 130 }); // 129.87 -> 130
    expect(quote.totalCents).toBe(1430);
  });

  it("returns zero tax when no region is configured", async () => {
    withRegion(db, null);
    const calc = new ConfiguredRateTaxCalculator(db);
    const quote = await calc.quote([{ ref: "a", taxableCents: 5000, taxCategory: null }], ON);
    expect(quote).toEqual({
      regionName: null,
      lines: [{ ref: "a", taxCents: 0, rates: [] }],
      totalCents: 0,
    });
  });

  it("only applies a category-specific rate to matching lines", async () => {
    withRegion(db, {
      name: "Ontario",
      rates: [
        { name: "HST", rate: "0.050000", taxCategory: "", compound: false },
        { name: "LuxuryLevy", rate: "0.100000", taxCategory: "luxury", compound: false },
      ],
    });
    const calc = new ConfiguredRateTaxCalculator(db);
    const quote = await calc.quote(
      [
        { ref: "std", taxableCents: 10000, taxCategory: "standard" },
        { ref: "lux", taxableCents: 10000, taxCategory: "luxury" },
      ],
      ON,
    );
    expect(quote.lines[0]!.taxCents).toBe(500); // HST only
    expect(quote.lines[1]!.taxCents).toBe(1500); // HST + luxury
  });

  it("charges a compound rate on the running total", async () => {
    withRegion(db, {
      name: "Quebec",
      rates: [
        { name: "GST", rate: "0.050000", taxCategory: "", compound: false },
        { name: "QST", rate: "0.099750", taxCategory: "", compound: true },
      ],
    });
    const calc = new ConfiguredRateTaxCalculator(db);
    const quote = await calc.quote([{ ref: "a", taxableCents: 10000, taxCategory: null }], {
      country: "CA",
      province: "QC",
    });
    // GST 500; QST on 10500 = 1047.375 -> 1047
    expect(quote.lines[0]!.rates.map((r) => r.amountCents)).toEqual([500, 1047]);
    expect(quote.lines[0]!.taxCents).toBe(1547);
  });
});
