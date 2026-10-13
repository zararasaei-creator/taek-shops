// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  comboKey,
  computeCartesianProduct,
  slugifySkuPart,
  suggestSku,
  type MatrixOptionGroup,
} from "@/lib/catalog/variant-matrix";

describe("computeCartesianProduct", () => {
  it("returns nothing for zero groups", () => {
    expect(computeCartesianProduct([])).toEqual([]);
  });

  it("returns nothing when any group has no selected values", () => {
    const groups: MatrixOptionGroup[] = [
      { optionId: "o1", optionName: "Size", values: [{ id: "v1", value: "S" }] },
      { optionId: "o2", optionName: "Colour", values: [] },
    ];
    expect(computeCartesianProduct(groups)).toEqual([]);
  });

  it("multiplies a single group straight through", () => {
    const groups: MatrixOptionGroup[] = [
      {
        optionId: "o1",
        optionName: "Size",
        values: [
          { id: "v1", value: "S" },
          { id: "v2", value: "M" },
        ],
      },
    ];
    const combos = computeCartesianProduct(groups);
    expect(combos).toHaveLength(2);
    expect(combos.map((c) => c.selections.map((s) => s.value))).toEqual([["S"], ["M"]]);
  });

  it("computes the full Cartesian product across multiple groups", () => {
    const groups: MatrixOptionGroup[] = [
      {
        optionId: "o1",
        optionName: "Size",
        values: [
          { id: "s1", value: "S" },
          { id: "s2", value: "M" },
        ],
      },
      {
        optionId: "o2",
        optionName: "Colour",
        values: [
          { id: "c1", value: "White" },
          { id: "c2", value: "Black" },
        ],
      },
    ];
    const combos = computeCartesianProduct(groups);
    expect(combos).toHaveLength(4);
    expect(combos.map((c) => c.selections.map((s) => s.value))).toEqual([
      ["S", "White"],
      ["S", "Black"],
      ["M", "White"],
      ["M", "Black"],
    ]);
  });

  it("scales to three dimensions", () => {
    const groups: MatrixOptionGroup[] = [
      {
        optionId: "o1",
        optionName: "Size",
        values: [
          { id: "s1", value: "S" },
          { id: "s2", value: "M" },
        ],
      },
      { optionId: "o2", optionName: "Colour", values: [{ id: "c1", value: "White" }] },
      {
        optionId: "o3",
        optionName: "Length",
        values: [
          { id: "l1", value: "Short" },
          { id: "l2", value: "Long" },
        ],
      },
    ];
    expect(computeCartesianProduct(groups)).toHaveLength(4);
  });
});

describe("comboKey", () => {
  it("is order-independent", () => {
    const a = comboKey([
      { optionName: "Size", value: "S" },
      { optionName: "Colour", value: "White" },
    ]);
    const b = comboKey([
      { optionName: "Colour", value: "White" },
      { optionName: "Size", value: "S" },
    ]);
    expect(a).toBe(b);
  });

  it("is case-insensitive", () => {
    const a = comboKey([{ optionName: "Size", value: "S" }]);
    const b = comboKey([{ optionName: "SIZE", value: "s" }]);
    expect(a).toBe(b);
  });

  it("distinguishes different combinations", () => {
    const a = comboKey([{ optionName: "Size", value: "S" }]);
    const b = comboKey([{ optionName: "Size", value: "M" }]);
    expect(a).not.toBe(b);
  });
});

describe("slugifySkuPart / suggestSku", () => {
  it("upper-cases and replaces non-alphanumerics with a single hyphen", () => {
    expect(slugifySkuPart("white / black")).toBe("WHITE-BLACK");
    expect(slugifySkuPart("  size m  ")).toBe("SIZE-M");
  });

  it("builds a combined suggested SKU", () => {
    const sku = suggestSku("dobok-v-neck", [{ value: "S" }, { value: "White" }]);
    expect(sku).toBe("DOBOK-V-NECK-S-WHITE");
  });
});
