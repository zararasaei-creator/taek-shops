// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ImportFileError } from "@/server/import/errors";
import { resolveRowSource } from "@/server/import/row-source";

describe("resolveRowSource", () => {
  it("resolves a .csv file to the CSV reader", () => {
    expect(resolveRowSource("products.csv").format).toBe("csv");
    expect(resolveRowSource("Products.CSV").format).toBe("csv");
  });

  it("resolves a .xlsx file to the XLSX reader", () => {
    expect(resolveRowSource("products.xlsx").format).toBe("xlsx");
    expect(resolveRowSource("Products.XLSX").format).toBe("xlsx");
  });

  it("resolves by MIME type when the name has no useful extension", () => {
    expect(resolveRowSource("upload", "text/csv").format).toBe("csv");
    expect(resolveRowSource("upload", "application/vnd.ms-excel; charset=utf-8").format).toBe(
      "csv",
    );
    expect(
      resolveRowSource(
        "upload",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ).format,
    ).toBe("xlsx");
  });

  it("rejects a known-but-unsupported spreadsheet format with a clear, actionable message", () => {
    // .xlsx graduated to supported this pass — these three remain refused.
    for (const name of ["catalog.xlsm", "catalog.xls", "catalog.ods"]) {
      let thrown: unknown;
      try {
        resolveRowSource(name);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ImportFileError);
      expect((thrown as ImportFileError).code).toBe("unsupported_format");
      expect((thrown as ImportFileError).publicMessage).toMatch(/csv|xlsx/i);
    }
  });

  it("falls back to CSV for an unknown/extensionless upload (unchanged behaviour)", () => {
    expect(resolveRowSource("data").format).toBe("csv");
    expect(resolveRowSource("data.txt").format).toBe("csv");
  });
});
