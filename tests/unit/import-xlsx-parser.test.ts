// @vitest-environment node
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImportFileError } from "@/server/import/errors";
import { parseXlsx } from "@/server/import/xlsx-parser";

/**
 * Real `.xlsx` bytes, generated with the same library the parser uses to
 * read them — exercising genuine OOXML structure (zip + XML), not a hand-
 * crafted approximation. Covers the documented worksheet rules, the
 * formula-rejection guarantee, text-SKU/leading-zero preservation (and its
 * honest limit), malformed input, and the row/column caps.
 */

async function buildWorkbook(
  rows: (string | number | { formula: string; result?: number })[][],
  opts: { sheetName?: string; extraSheets?: { name: string; hasData: boolean }[] } = {},
): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(opts.sheetName ?? "Sheet1");
  for (const row of rows) {
    sheet.addRow(row);
  }
  for (const extra of opts.extraSheets ?? []) {
    const sheet2 = workbook.addWorksheet(extra.name);
    if (extra.hasData) sheet2.addRow(["x", "y"]);
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

const HEADER = ["sku", "product_name", "product_slug", "price"];

describe("parseXlsx — valid imports", () => {
  it("parses a valid worksheet with 1-based, header-is-row-1 row numbers — same semantics as CSV", async () => {
    const bytes = await buildWorkbook([
      HEADER,
      ["ABC-1", "Widget", "widget", 9.99],
      ["ABC-2", "Gadget", "gadget", 19.99],
    ]);
    const table = await parseXlsx(bytes, "hash");
    expect(table.format).toBe("xlsx");
    expect(table.columns).toEqual(["sku", "product_name", "product_slug", "price"]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]).toMatchObject({
      rowNumber: 2,
      values: { sku: "ABC-1", product_name: "Widget", price: "9.99" },
    });
    expect(table.rows[1]!.rowNumber).toBe(3);
  });

  it("normalises headers the same way CSV does", async () => {
    const bytes = await buildWorkbook([["SKU", "Product Name", "Compare-At Price"], ["A-1", "X", 1]]);
    const table = await parseXlsx(bytes, "hash");
    expect(table.columns).toEqual(["sku", "product_name", "compare_at_price"]);
  });
});

describe("parseXlsx — text SKUs, including leading zeros", () => {
  it("preserves a leading zero when the cell is genuinely text-typed", async () => {
    const bytes = await buildWorkbook([HEADER, ["00123", "Widget", "widget", 9.99]]);
    const table = await parseXlsx(bytes, "hash");
    expect(table.rows[0]!.values.sku).toBe("00123");
  });

  it("documents the honest limit: a numerically-formatted cell has already lost its leading zero before this file is read", async () => {
    // Assigning a JS number (not a string) is exactly what a spreadsheet
    // does internally once a cell is General/Number-formatted and the user
    // types "00123" — Excel itself converts it to 123 at entry time. No
    // reader can recover information the source file never retained.
    const bytes = await buildWorkbook([HEADER, [123, "Widget", "widget", 9.99]]);
    const table = await parseXlsx(bytes, "hash");
    expect(table.rows[0]!.values.sku).toBe("123");
  });
});

describe("parseXlsx — formula cells are explicitly rejected with a clear error, never silently ignored", () => {
  it("never reads a formula cell's cached result, and the row carries a hard error — not just a soft warning", async () => {
    const bytes = await buildWorkbook([
      HEADER,
      ["ABC-1", "Widget", "widget", { formula: "1+1", result: 999 }],
    ]);
    const table = await parseXlsx(bytes, "hash");
    expect(table.rows[0]!.values.price).toBe(""); // never "999", never "2"
    // A genuine formula is a hard, explicit row-level error — stronger than
    // the soft `neutralizedColumns` warning CSV's own leading-character
    // trigger produces, specifically so a formula in an OPTIONAL column
    // can never slip through as if nothing happened.
    expect(table.rows[0]!.neutralizedColumns).not.toContain("price");
    expect(table.rows[0]!.formatErrors).toMatchObject([
      { column: "price", code: "formula_cell_rejected" },
    ]);
  });

  it("flags every formula column on a row with multiple formula cells", async () => {
    const bytes = await buildWorkbook([
      HEADER,
      [
        { formula: "A1", result: "ABC-1" } as unknown as string,
        "Widget",
        "widget",
        { formula: "1+1", result: 999 },
      ],
    ]);
    const table = await parseXlsx(bytes, "hash");
    const columns = table.rows[0]!.formatErrors!.map((e) => e.column);
    expect(columns).toEqual(["sku", "price"]);
  });
});

describe("parseXlsx — worksheet rules are explicit, never a silent guess", () => {
  it("uses the single populated worksheet regardless of its position", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Empty Intro"); // no rows at all
    const data = workbook.addWorksheet("Real Data");
    data.addRow(HEADER);
    data.addRow(["ABC-1", "Widget", "widget", 9.99]);
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());

    const table = await parseXlsx(bytes, "hash");
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]!.values.sku).toBe("ABC-1");
  });

  it("rejects a workbook with more than one populated worksheet, never silently dropping one", async () => {
    const bytes = await buildWorkbook([HEADER, ["ABC-1", "Widget", "widget", 9.99]], {
      extraSheets: [{ name: "Also Has Data", hasData: true }],
    });
    await expect(parseXlsx(bytes, "hash")).rejects.toMatchObject({
      code: "multiple_worksheets",
    });
  });

  it("tolerates an extra worksheet that is genuinely empty", async () => {
    const bytes = await buildWorkbook([HEADER, ["ABC-1", "Widget", "widget", 9.99]], {
      extraSheets: [{ name: "Blank", hasData: false }],
    });
    const table = await parseXlsx(bytes, "hash");
    expect(table.rows).toHaveLength(1);
  });
});

describe("parseXlsx — malformed input", () => {
  it("rejects an empty file", async () => {
    await expect(parseXlsx(new Uint8Array(0), "hash")).rejects.toThrow(/empty/i);
  });

  it("rejects bytes that are not a valid zip/XLSX, with a clear message, not a crash", async () => {
    const garbage = new TextEncoder().encode("this is not a spreadsheet");
    await expect(parseXlsx(garbage, "hash")).rejects.toBeInstanceOf(ImportFileError);
    await expect(parseXlsx(garbage, "hash")).rejects.toMatchObject({ code: "unparseable" });
  });

  it("rejects a workbook with a header but no data rows", async () => {
    const bytes = await buildWorkbook([HEADER]);
    await expect(parseXlsx(bytes, "hash")).rejects.toThrow(/no data rows/i);
  });

  it("rejects duplicate column headings", async () => {
    const bytes = await buildWorkbook([["sku", "sku", "price"], ["A-1", "B-1", "1.00"]]);
    await expect(parseXlsx(bytes, "hash")).rejects.toThrow(/duplicate/i);
  });
});

describe("parseXlsx — bounded resource use", () => {
  it("rejects a worksheet with more columns than the configured limit", async () => {
    const header = Array.from({ length: 201 }, (_, i) => `col_${i}`);
    const bytes = await buildWorkbook([header, header.map(() => "x")]);
    await expect(parseXlsx(bytes, "hash")).rejects.toMatchObject({ code: "too_many_columns" });
  });

  it("enforces the configured row cap", async () => {
    vi.stubEnv("IMPORT_MAX_ROW_COUNT", "5");
    vi.resetModules();
    const { parseXlsx: cappedParse } = await import("@/server/import/xlsx-parser");

    const rows = Array.from({ length: 8 }, (_, i) => [`SKU-${i}`, "x", "x", 1]);
    const bytes = await buildWorkbook([HEADER, ...rows]);
    await expect(cappedParse(bytes, "hash")).rejects.toThrow(/limit is 5/);
  });

  it("rejects a file over the configured byte-size limit", async () => {
    vi.stubEnv("IMPORT_MAX_FILE_SIZE_BYTES", "10");
    vi.resetModules();
    const { parseXlsx: cappedParse } = await import("@/server/import/xlsx-parser");

    const bytes = await buildWorkbook([HEADER, ["ABC-1", "Widget", "widget", 9.99]]);
    expect(bytes.byteLength).toBeGreaterThan(10);
    await expect(cappedParse(bytes, "hash")).rejects.toThrow(/limit/i);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
