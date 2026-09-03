// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  addCents,
  applyRate,
  assertCents,
  formatCents,
  MoneyError,
  multiplyCents,
  parseAmountToCents,
  toDecimal,
} from "@/server/domain/money";

describe("money", () => {
  it("parses decimal money strings to exact integer cents", () => {
    expect(parseAmountToCents("29.99")).toBe(2999);
    expect(parseAmountToCents("0")).toBe(0);
    expect(parseAmountToCents("1")).toBe(100);
    expect(parseAmountToCents("2.67")).toBe(267);
    expect(parseAmountToCents("$1,000")).toBe(100_000);
    expect(parseAmountToCents(" 5.5 ")).toBe(550);
    expect(parseAmountToCents("-3.20")).toBe(-320);
  });

  it("rejects money strings it cannot parse exactly", () => {
    expect(() => parseAmountToCents("29.999")).toThrow(MoneyError);
    expect(() => parseAmountToCents("abc")).toThrow(MoneyError);
    expect(() => parseAmountToCents("")).toThrow(MoneyError);
  });

  it("round-trips cents to a decimal number for display", () => {
    expect(toDecimal(2999)).toBeCloseTo(29.99, 10);
  });

  it("rejects non-integer cents", () => {
    expect(() => assertCents(29.99)).toThrow(MoneyError);
    expect(() => toDecimal(10.5)).toThrow(MoneyError);
  });

  it("adds and multiplies without floating-point drift", () => {
    expect(addCents(1000, 2050, 999)).toBe(4049);
    expect(multiplyCents(1999, 3)).toBe(5997);
    expect(() => multiplyCents(100, 1.5)).toThrow(MoneyError);
  });

  it("applies an exact fractional rate and returns integer cents", () => {
    expect(applyRate(10_000, 0.13)).toBe(1300);
    expect(applyRate(2999, 0.13)).toBe(390);
    expect(() => applyRate(1000, -0.1)).toThrow(MoneyError);
  });

  it("formats cents as CAD currency", () => {
    expect(formatCents(2999)).toBe("$29.99");
    expect(formatCents(0)).toBe("$0.00");
  });
});
