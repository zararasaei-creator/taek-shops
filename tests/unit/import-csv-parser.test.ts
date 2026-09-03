// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeHeader, parseCsv } from "@/server/import/csv-parser";
import { ImportFileError } from "@/server/import/errors";

const enc = (text: string) => new TextEncoder().encode(text);

describe("normalizeHeader", () => {
  it("lower-cases and normalises separators", () => {
    expect(normalizeHeader("Product Name")).toBe("product_name");
    expect(normalizeHeader("compare-at-price")).toBe("compare_at_price");
    expect(normalizeHeader("  SKU ")).toBe("sku");
  });
});

describe("parseCsv", () => {
  it("parses a valid table with 1-based row numbers", () => {
    const table = parseCsv(enc("sku,price\r\nABC-1,9.99\r\nABC-2,19.99\r\n"), "hash");
    expect(table.columns).toEqual(["sku", "price"]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]).toMatchObject({ rowNumber: 2, values: { sku: "ABC-1", price: "9.99" } });
    expect(table.rows[1]!.rowNumber).toBe(3);
  });

  it("neutralises formula cells and records which columns", () => {
    const table = parseCsv(enc('sku,name\nABC-1,"=cmd"\n'), "hash");
    expect(table.rows[0]!.values.name).toBe("cmd");
    expect(table.rows[0]!.neutralizedColumns).toContain("name");
  });

  it("rejects an empty file", () => {
    expect(() => parseCsv(enc(""), "hash")).toThrow(ImportFileError);
  });

  it("rejects a header with no data rows", () => {
    expect(() => parseCsv(enc("sku,price\n"), "hash")).toThrow(/no data rows/i);
  });

  it("rejects duplicate column headings", () => {
    expect(() => parseCsv(enc("sku,sku\nA,B\n"), "hash")).toThrow(/duplicate/i);
  });

  it("rejects non-UTF-8 input", () => {
    const invalid = new Uint8Array([0x73, 0x6b, 0x75, 0x0a, 0xff, 0xfe]);
    expect(() => parseCsv(invalid, "hash")).toThrow(/UTF-8/i);
  });

  it("enforces the configured row cap", async () => {
    vi.stubEnv("IMPORT_MAX_ROW_COUNT", "5");
    vi.resetModules();
    const { parseCsv: cappedParse } = await import("@/server/import/csv-parser");

    const rows = Array.from({ length: 8 }, (_, i) => `SKU-${i},1.00`).join("\n");
    expect(() => cappedParse(enc(`sku,price\n${rows}\n`), "hash")).toThrow(/limit is 5/);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
