// @vitest-environment node
import { UserRole } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { buildImportErrorReportCsv } from "@/server/import/import-queries";
import { createMockPrisma, looseMock } from "./helpers/mock-prisma";

/**
 * Unit-level coverage for `buildImportErrorReportCsv`'s own CSV-writing and
 * bounded-read behavior, with a mocked Prisma client — the realistic
 * failure scenarios (a genuine duplicate-SKU validation error) are covered
 * against a real database in
 * `tests/integration/import-history.integration.test.ts`. This file exists
 * for two things a real fixture can't cheaply exercise: (1) proving every
 * cell — including one deliberately shaped like a formula-injection
 * payload — passes through the shared CSV-escaping helper, and (2) proving
 * the export paginates its own reads instead of one unbounded query.
 */

const manager = { id: "mgr", role: UserRole.MANAGER };

function rowError(overrides: Partial<{ column: string | null; code: string; message: string }> = {}) {
  return { column: null, code: "test_code", message: "A row failed.", ...overrides };
}

describe("buildImportErrorReportCsv", () => {
  it("escapes a formula-injection-shaped error message and original value instead of writing them raw", async () => {
    const db = createMockPrisma();
    looseMock(db.importJob.findUnique).mockImplementation(() =>
      Promise.resolve({ id: "job1", originalFilename: "risky.csv" } as never),
    );
    looseMock(db.importJobRow.findMany).mockImplementation(({ skip }: { skip: number }) =>
      Promise.resolve(
        skip === 0
          ? ([
              {
                rowNumber: 2,
                sku: "SKU-1",
                errors: [rowError({ column: "product_name", code: "bad_value", message: "=cmd|' /C calc'!A0" })],
                rawData: { raw: { product_name: "@SUM(1+1)" } },
              },
            ] as never)
          : ([] as never),
      ),
    );

    const report = await buildImportErrorReportCsv(manager, "job1", db);

    // Every cell that could have carried a formula trigger is prefixed with
    // `'` by the shared `toCsv` helper — never written verbatim.
    expect(report.csv).toContain("'=cmd|' /C calc'!A0");
    expect(report.csv).toContain("'@SUM(1+1)");
    expect(report.csv).not.toMatch(/,=cmd/); // never an unescaped leading `=` after a comma
  });

  it("quotes a value containing a comma or newline (RFC 4180), reusing the shared CSV writer", async () => {
    const db = createMockPrisma();
    looseMock(db.importJob.findUnique).mockImplementation(() =>
      Promise.resolve({ id: "job1", originalFilename: "quoting.csv" } as never),
    );
    looseMock(db.importJobRow.findMany).mockImplementation(({ skip }: { skip: number }) =>
      Promise.resolve(
        skip === 0
          ? ([
              {
                rowNumber: 5,
                sku: "SKU-2",
                errors: [rowError({ message: "Price, cost, and barcode all look wrong" })],
                rawData: { raw: {} },
              },
            ] as never)
          : ([] as never),
      ),
    );

    const report = await buildImportErrorReportCsv(manager, "job1", db);
    expect(report.csv).toContain('"Price, cost, and barcode all look wrong"');
  });

  it("emits one CSV line per (row, error) pair when a row has multiple errors", async () => {
    const db = createMockPrisma();
    looseMock(db.importJob.findUnique).mockImplementation(() =>
      Promise.resolve({ id: "job1", originalFilename: "multi.csv" } as never),
    );
    looseMock(db.importJobRow.findMany).mockImplementation(({ skip }: { skip: number }) =>
      Promise.resolve(
        skip === 0
          ? ([
              {
                rowNumber: 3,
                sku: "SKU-3",
                errors: [rowError({ code: "e1", message: "first" }), rowError({ code: "e2", message: "second" })],
                rawData: { raw: {} },
              },
            ] as never)
          : ([] as never),
      ),
    );

    const report = await buildImportErrorReportCsv(manager, "job1", db);
    expect(report.rowCount).toBe(2);
    expect(report.csv).toContain("first");
    expect(report.csv).toContain("second");
  });

  it("reads failed rows in bounded pages, never one unbounded query", async () => {
    const db = createMockPrisma();
    looseMock(db.importJob.findUnique).mockImplementation(() =>
      Promise.resolve({ id: "job1", originalFilename: "big.csv" } as never),
    );
    const findMany = vi.fn().mockImplementation(({ skip, take }: { skip: number; take: number }) => {
      // Two full pages, then a short final page — proves pagination drives
      // the loop rather than a single `findMany` with no `take`.
      if (skip === 0) {
        return Promise.resolve(
          Array.from({ length: take }, (_, i) => ({
            rowNumber: i,
            sku: `S${i}`,
            errors: [rowError()],
            rawData: { raw: {} },
          })) as never,
        );
      }
      if (skip === take) {
        return Promise.resolve([{ rowNumber: 999, sku: "LAST", errors: [rowError()], rawData: { raw: {} } }] as never);
      }
      return Promise.resolve([] as never);
    });
    looseMock(db.importJobRow.findMany).mockImplementation(findMany);

    const report = await buildImportErrorReportCsv(manager, "job1", db);

    expect(findMany.mock.calls.length).toBeGreaterThanOrEqual(2); // more than one page fetched
    // Every call passed an explicit `take` — never an unbounded read.
    for (const [args] of findMany.mock.calls as [{ take: number }][]) {
      expect(args.take).toBeGreaterThan(0);
    }
    expect(report.rowCount).toBeGreaterThan(0);
  });
});
