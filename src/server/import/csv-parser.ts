import { parse } from "csv-parse/sync";

import { serverEnv } from "@/server/config/env";
import { ImportFileError } from "@/server/import/errors";
import { neutralizeForImport } from "@/server/import/cell-sanitize";

/**
 * Safe CSV reader.
 *
 * - hard byte-size and row-count caps (`IMPORT_MAX_FILE_SIZE_BYTES`,
 *   `IMPORT_MAX_ROW_COUNT`);
 * - rejects non-UTF-8 input;
 * - never evaluates a formula - every cell is neutralised as text;
 * - header normalisation (lower-case, spaces/dashes -> `_`), duplicate-header
 *   detection.
 *
 * The `SourceFormat` seam keeps the door open for an XLSX reader later without
 * touching callers: it would produce the same `ParsedTable`.
 */

export type SourceFormat = "csv";

export interface ParsedRow {
  /** 1-based row number as it appears in the file (header is row 1). */
  rowNumber: number;
  /** Column key -> neutralised string value. */
  values: Record<string, string>;
  /** Columns whose value was altered by injection neutralisation. */
  neutralizedColumns: string[];
}

export interface ParsedTable {
  format: SourceFormat;
  columns: string[];
  rows: ParsedRow[];
  fileHash: string;
}

const BOM_CODEPOINT = 0xfeff;

function stripBom(value: string): string {
  return value.charCodeAt(0) === BOM_CODEPOINT ? value.slice(1) : value;
}

export function normalizeHeader(raw: string): string {
  return stripBom(raw)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function assertUtf8(bytes: Uint8Array): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    return stripBom(decoder.decode(bytes));
  } catch {
    throw new ImportFileError("not_utf8", "The file is not valid UTF-8 text.");
  }
}

export function parseCsv(bytes: Uint8Array, fileHash: string): ParsedTable {
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

  const text = assertUtf8(bytes);

  let records: string[][];
  try {
    records = parse(text, {
      bom: true,
      columns: false,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
      // `to` bounds parsing; +1 for the header. Over-limit is reported below.
      to: maxRows + 2,
    }) as string[][];
  } catch (error) {
    throw new ImportFileError(
      "unparseable",
      `The file could not be parsed as CSV: ${(error as Error).message}`,
    );
  }

  if (records.length === 0) {
    throw new ImportFileError("no_data_rows", "The file has no rows.");
  }

  const rawHeader = records[0] ?? [];
  const columns = rawHeader.map(normalizeHeader);
  const seen = new Map<string, number>();
  const duplicates: string[] = [];
  for (const column of columns) {
    seen.set(column, (seen.get(column) ?? 0) + 1);
    if (seen.get(column) === 2) duplicates.push(column);
  }
  if (duplicates.length > 0) {
    throw new ImportFileError(
      "duplicate_columns",
      `Duplicate column heading(s): ${duplicates.join(", ")}.`,
    );
  }

  const dataRecords = records.slice(1);
  if (dataRecords.length === 0) {
    throw new ImportFileError("no_data_rows", "The file has a header but no data rows.");
  }
  if (dataRecords.length > maxRows) {
    throw new ImportFileError(
      "too_many_rows",
      `The file has ${dataRecords.length} data rows; the limit is ${maxRows}.`,
    );
  }

  const rows: ParsedRow[] = dataRecords.map((record, index) => {
    const values: Record<string, string> = {};
    const neutralizedColumns: string[] = [];
    columns.forEach((column, columnIndex) => {
      if (!column) return;
      const { value, wasNeutralized } = neutralizeForImport(record[columnIndex] ?? "");
      values[column] = value;
      if (wasNeutralized) neutralizedColumns.push(column);
    });
    return { rowNumber: index + 2, values, neutralizedColumns };
  });

  return { format: "csv", columns: columns.filter(Boolean), rows, fileHash };
}
