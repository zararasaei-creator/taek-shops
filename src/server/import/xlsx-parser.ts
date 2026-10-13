import ExcelJS from "exceljs";

import { serverEnv } from "@/server/config/env";
import { ImportFileError } from "@/server/import/errors";
import { neutralizeForImport } from "@/server/import/cell-sanitize";
import { normalizeHeader, type ParsedRow, type ParsedTable } from "@/server/import/csv-parser";
import { assertBoundedXlsxArchive } from "@/server/import/xlsx-archive-guard";

/**
 * Safe XLSX reader (Phase 10). Produces the exact same `ParsedTable` shape
 * `parseCsv` does, so nothing downstream (`previewImport`/`commitImport`/
 * `parseProductRow`/the whole validation and commit pipeline) needs to know
 * or care which format a file came from — this is the whole point of the
 * `RowSource` seam in `row-source.ts`.
 *
 * **Worksheet handling, documented explicitly** (never silently guessed):
 * exactly one worksheet may contain data (`actualRowCount > 0`) — that one
 * is used regardless of its position in the workbook. Zero populated
 * worksheets is "no data rows," same as an empty CSV. **More than one
 * populated worksheet is rejected outright** with a clear error naming
 * every sheet that has data — never silently reading one and discarding
 * the other sheet's data. The header is always that worksheet's row 1;
 * there is no column-mapping UI, matching the CSV path exactly.
 *
 * **Security, by construction, not just by convention:**
 * - **Formula cells are explicitly rejected, with a clear row-level
 *   error — never silently ignored.** A formula cell's cached `result` is
 *   never read; its value is always empty, AND the row carries a hard
 *   `formula_cell_rejected` error naming the column (see `formatErrors`
 *   below) — this is stronger than CSV's own leading-character handling
 *   (which neutralizes suspicious *text* and lets normal validation decide
 *   whether the resulting gap matters). A genuine formula cell is a
 *   materially different, more serious signal than a CSV cell that merely
 *   starts with `=`, so it is never just a soft warning that a row with a
 *   formula in an optional field could otherwise sail through unnoticed.
 * - **No macro execution**: ExcelJS is a pure JS/XML/zip reader with no VBA
 *   engine at all — it cannot execute a macro even if one were present —
 *   and `.xlsm` is explicitly refused before this module ever runs (see
 *   `row-source.ts`), so a macro-bearing file never reaches here regardless.
 * - **No external workbook links are followed**: loading a workbook is a
 *   pure in-memory buffer parse; nothing in `exceljs`'s load path performs
 *   network or filesystem I/O for external references.
 * - **Bounded resource use, including decompression — not just the
 *   compressed upload size**: `assertBoundedXlsxArchive`
 *   (`xlsx-archive-guard.ts`) runs BEFORE `exceljs` ever loads the
 *   workbook, streaming each ZIP entry's decompression and aborting the
 *   instant a per-entry or whole-archive decompressed-byte limit is
 *   exceeded — enforced while decompressing, not from ZIP metadata and not
 *   only after an entry is fully materialized. See that module's own doc
 *   comment for the exact limits and the one documented remaining gap
 *   (wall-clock CPU time for a pathological entry count/structure, bounded
 *   indirectly by the entry-count cap and the pre-existing upload-size cap).
 */

const MAX_IMPORT_COLUMNS = 200; // generous relative to ~20 real columns; bounds a pathologically wide sheet

function stringifyCellValue(cell: ExcelJS.Cell): string {
  switch (cell.type) {
    case ExcelJS.ValueType.Null:
      return "";
    case ExcelJS.ValueType.Date:
      return cell.value instanceof Date ? cell.value.toISOString() : "";
    case ExcelJS.ValueType.RichText:
    case ExcelJS.ValueType.Hyperlink:
      return cell.text ?? "";
    case ExcelJS.ValueType.Formula:
    case ExcelJS.ValueType.Error:
      // Never read `cell.result` — a formula's cached result is not
      // trusted data, and an error cell carries no usable value either.
      return "";
    default:
      // Number, String, Boolean, SharedString: `cell.value` is already a
      // primitive. A text-formatted cell's string (including a leading
      // zero in something like a SKU) comes through exactly as typed —
      // Excel itself converts a *numerically-formatted* cell to a real
      // number before this file ever sees it, which is a property of the
      // source spreadsheet's own formatting, not something any reader can
      // recover after the fact (documented in the admin upload copy).
      return cell.value == null ? "" : String(cell.value);
  }
}

interface CellOutcome {
  value: string;
  /** Soft signal: a text-ish value started with a formula-trigger character — neutralized, not an error. */
  wasNeutralized: boolean;
  /** Hard signal: a genuine formula cell — never a soft warning, always a row-level error. */
  isFormula: boolean;
}

function cellToParsedValue(cell: ExcelJS.Cell): CellOutcome {
  if (cell.type === ExcelJS.ValueType.Formula) {
    return { value: "", wasNeutralized: false, isFormula: true };
  }
  const { value, wasNeutralized } = neutralizeForImport(stringifyCellValue(cell));
  return { value, wasNeutralized, isFormula: false };
}

export async function parseXlsx(bytes: Uint8Array, fileHash: string): Promise<ParsedTable> {
  const maxBytes = serverEnv.IMPORT_MAX_FILE_SIZE_BYTES;
  const maxRows = serverEnv.IMPORT_MAX_ROW_COUNT;

  if (bytes.byteLength === 0) {
    throw new ImportFileError("empty_file", "The uploaded file is empty.");
  }
  if (bytes.byteLength > maxBytes) {
    throw new ImportFileError(
      "file_too_large",
      `The file is larger than the ${maxBytes.toLocaleString()} byte limit.`,
    );
  }

  // Bounded archive processing happens BEFORE exceljs ever touches this
  // buffer — see `xlsx-archive-guard.ts` for exactly what this checks and
  // why checking the compressed upload size alone is not sufficient.
  await assertBoundedXlsxArchive(bytes);

  const workbook = new ExcelJS.Workbook();
  try {
    // `exceljs`'s bundled types predate Node's generic `Buffer<T>` — the
    // runtime value is a completely ordinary `Buffer`, only the type
    // parameter is unfamiliar to its declaration. `any` is required here:
    // even `unknown as Buffer` still fails to structurally unify against
    // exceljs's own `Buffer` reference.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workbook.xlsx.load(Buffer.from(bytes) as any);
  } catch (error) {
    throw new ImportFileError(
      "unparseable",
      `The file could not be parsed as XLSX: ${(error as Error).message}`,
    );
  }

  const populated = workbook.worksheets.filter((sheet) => sheet.actualRowCount > 0);
  if (populated.length === 0) {
    throw new ImportFileError("no_data_rows", "The file has no rows.");
  }
  if (populated.length > 1) {
    throw new ImportFileError(
      "multiple_worksheets",
      `This file has data on ${populated.length} worksheets (${populated
        .map((s) => s.name)
        .join(", ")}). Put all data on a single worksheet and remove or empty the others, then re-upload.`,
    );
  }
  const sheet = populated[0]!;

  const colCount = Math.max(sheet.columnCount, sheet.actualColumnCount);
  if (colCount > MAX_IMPORT_COLUMNS) {
    throw new ImportFileError(
      "too_many_columns",
      `The worksheet has ${colCount} columns; the limit is ${MAX_IMPORT_COLUMNS}.`,
    );
  }

  const headerRow = sheet.getRow(1);
  const rawHeader: string[] = [];
  for (let c = 1; c <= colCount; c++) {
    rawHeader.push(cellToParsedValue(headerRow.getCell(c)).value);
  }
  const columns = rawHeader.map(normalizeHeader);
  const seenHeaders = new Map<string, number>();
  const duplicateHeaders: string[] = [];
  for (const column of columns) {
    if (!column) continue;
    seenHeaders.set(column, (seenHeaders.get(column) ?? 0) + 1);
    if (seenHeaders.get(column) === 2) duplicateHeaders.push(column);
  }
  if (duplicateHeaders.length > 0) {
    throw new ImportFileError(
      "duplicate_columns",
      `Duplicate column heading(s): ${duplicateHeaders.join(", ")}.`,
    );
  }

  const dataRowCount = sheet.actualRowCount - 1; // minus the header row
  if (dataRowCount <= 0) {
    throw new ImportFileError("no_data_rows", "The file has a header but no data rows.");
  }
  if (dataRowCount > maxRows) {
    throw new ImportFileError(
      "too_many_rows",
      `The file has ${dataRowCount} data rows; the limit is ${maxRows}.`,
    );
  }

  const rows: ParsedRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return; // header, already consumed
    const values: Record<string, string> = {};
    const neutralizedColumns: string[] = [];
    const formulaColumns: string[] = [];
    for (let c = 1; c <= colCount; c++) {
      const column = columns[c - 1];
      if (!column) continue;
      const outcome = cellToParsedValue(row.getCell(c));
      values[column] = outcome.value;
      if (outcome.wasNeutralized) neutralizedColumns.push(column);
      if (outcome.isFormula) formulaColumns.push(column);
    }
    // Same 1-based, header-is-row-1 numbering a spreadsheet already uses —
    // identical semantics to `parseCsv`'s `rowNumber` (header = row 1,
    // first data row = row 2), so error messages/the error-report CSV read
    // the same regardless of source format.
    rows.push({
      rowNumber,
      values,
      neutralizedColumns,
      ...(formulaColumns.length > 0
        ? {
            formatErrors: formulaColumns.map((column) => ({
              column,
              code: "formula_cell_rejected",
              message: `Column "${column}" contains a formula, which is not supported — replace it with a plain value and re-upload.`,
            })),
          }
        : {}),
    });
  });

  return { format: "xlsx", columns: columns.filter(Boolean), rows, fileHash };
}
