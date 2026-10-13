// @vitest-environment node
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { ImportFileError } from "@/server/import/errors";
import { assertBoundedXlsxArchive } from "@/server/import/xlsx-archive-guard";
import { parseXlsx } from "@/server/import/xlsx-parser";

/**
 * Proves bounded ZIP-archive processing — the gap a compressed-upload-size
 * cap alone does not close. Every "bomb" here is a genuinely small
 * compressed file (well under `IMPORT_MAX_FILE_SIZE_BYTES`) that expands to
 * far more than this guard's decompressed-byte limits, built with the same
 * `jszip`/`exceljs` libraries the real parser uses — not a hand-waved
 * approximation.
 */

async function buildBombZip(entryName: string, decompressedByteSize: number): Promise<Uint8Array> {
  const zip = new JSZip();
  // Highly repetitive content compresses extremely well, exactly the
  // property a real zip bomb exploits — proves the guard catches this
  // class of input, not just "a big file."
  zip.file(entryName, "A".repeat(decompressedByteSize), {
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  return new Uint8Array(buffer);
}

async function buildManyEntriesZip(count: number): Promise<Uint8Array> {
  const zip = new JSZip();
  for (let i = 0; i < count; i++) {
    zip.file(`part${i}.xml`, "x");
  }
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  return new Uint8Array(buffer);
}

async function buildRealWorkbook(): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(["sku", "product_name", "product_slug", "price"]);
  sheet.addRow(["ABC-1", "Widget", "widget", 9.99]);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

describe("assertBoundedXlsxArchive — rejects before exceljs ever loads the workbook", () => {
  it("rejects a single entry whose decompressed size exceeds the per-entry limit, from a genuinely small compressed file", async () => {
    const decompressedSize = 60 * 1024 * 1024; // 60 MB, over the 50 MB per-entry cap
    const bomb = await buildBombZip("xl/worksheets/sheet1.xml", decompressedSize);

    // The whole point: tiny on disk, huge once inflated.
    expect(bomb.byteLength).toBeLessThan(1024 * 1024); // well under 1 MB compressed
    expect(bomb.byteLength).toBeLessThan(decompressedSize / 100); // >100x compression ratio

    const started = Date.now();
    await expect(assertBoundedXlsxArchive(bomb)).rejects.toMatchObject({
      code: "archive_entry_too_large",
    });
    // Rejected promptly — proof the guard aborted mid-decompression rather
    // than fully inflating 60 MB first (which would take measurably
    // longer and defeat the purpose of a bounded check).
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("rejects when several entries individually stay under the per-entry cap but together exceed the total cap", async () => {
    const zip = new JSZip();
    const perEntry = 30 * 1024 * 1024; // under the 50 MB per-entry cap...
    for (let i = 0; i < 5; i++) {
      // ...but 5 x 30 MB = 150 MB, over the 100 MB total cap.
      zip.file(`part${i}.xml`, "B".repeat(perEntry), {
        compression: "DEFLATE",
        compressionOptions: { level: 9 },
      });
    }
    const buffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
    const bomb = new Uint8Array(buffer);
    expect(bomb.byteLength).toBeLessThan(1024 * 1024);

    await expect(assertBoundedXlsxArchive(bomb)).rejects.toMatchObject({
      code: "archive_too_large",
    });
    // Building the 150 MB fixture (DEFLATE level 9) is the slow part — it takes ~5-11 s
    // depending on the machine, so Vitest's default 5 s timeout made this test fail on
    // slower hosts (found by the first clean-checkout CI run). The guard itself is still
    // asserted fast by the test above (< 5 s); only the fixture build gets headroom.
  }, 60_000);

  it("rejects an archive with more entries than the configured limit, from metadata alone", async () => {
    const manyEntries = await buildManyEntriesZip(150); // over the 100-entry cap
    await expect(assertBoundedXlsxArchive(manyEntries)).rejects.toMatchObject({
      code: "too_many_archive_entries",
    });
  });

  it("rejects bytes that are not a valid zip archive at all", async () => {
    const garbage = new TextEncoder().encode("not a zip file");
    await expect(assertBoundedXlsxArchive(garbage)).rejects.toBeInstanceOf(ImportFileError);
    await expect(assertBoundedXlsxArchive(garbage)).rejects.toMatchObject({ code: "unparseable" });
  });

  it("a normal, real workbook passes cleanly", async () => {
    const bytes = await buildRealWorkbook();
    await expect(assertBoundedXlsxArchive(bytes)).resolves.toBeUndefined();
  });
});

describe("parseXlsx — the archive guard runs first, so exceljs never sees a bomb", () => {
  it("a bomb is rejected by parseXlsx itself with the archive-guard's error, not an exceljs parse error", async () => {
    const bomb = await buildBombZip("xl/worksheets/sheet1.xml", 60 * 1024 * 1024);
    await expect(parseXlsx(bomb, "hash")).rejects.toMatchObject({ code: "archive_entry_too_large" });
  });

  it("a real, valid workbook still parses successfully end to end", async () => {
    const bytes = await buildRealWorkbook();
    const table = await parseXlsx(bytes, "hash");
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]!.values.sku).toBe("ABC-1");
  });
});
