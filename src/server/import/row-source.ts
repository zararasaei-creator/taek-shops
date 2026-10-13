import { parseCsv, type ParsedTable, type SourceFormat } from "@/server/import/csv-parser";
import { parseXlsx } from "@/server/import/xlsx-parser";
import { ImportFileError } from "@/server/import/errors";

/**
 * A `RowSource` turns an uploaded file's bytes into a format-neutral
 * `ParsedTable`. The import service only ever sees `ParsedTable`, so adding a
 * new tabular format means registering one more `RowSource` here — no change
 * to parsing/validation/commit.
 *
 * CSV and XLSX (`.xlsx` only — see `xlsx-parser.ts`'s module comment for
 * worksheet handling and the security properties it guarantees) ship today.
 * `.xls` (the legacy binary format), `.xlsm` (macro-enabled), and `.ods`
 * (OpenDocument) are explicitly recognised by extension but refused with a
 * clear message — never silently misread, and never a reason to add a
 * second, less-audited reader to this file. `parse` may be sync or async
 * (XLSX parsing is unavoidably async — it unzips/parses XML); callers must
 * always `await` it.
 */
export interface RowSource {
  readonly format: SourceFormat;
  readonly extensions: readonly string[];
  readonly mimeTypes: readonly string[];
  parse(bytes: Uint8Array, fileHash: string): ParsedTable | Promise<ParsedTable>;
}

const csvRowSource: RowSource = {
  format: "csv",
  extensions: [".csv"],
  mimeTypes: ["text/csv", "application/csv", "application/vnd.ms-excel", "text/plain"],
  parse: parseCsv,
};

const xlsxRowSource: RowSource = {
  format: "xlsx",
  extensions: [".xlsx"],
  // Deliberately NOT a generic "application/zip" fallback — `.xlsm`/`.ods`
  // are also zip-based and would wrongly match a loose MIME check before
  // ever reaching the `KNOWN_UNSUPPORTED` rejection below. The extension
  // match above is the reliable signal here, same as `csvRowSource`.
  mimeTypes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  parse: parseXlsx,
};

/** Registered, usable readers. */
const REGISTRY: readonly RowSource[] = [csvRowSource, xlsxRowSource];

/** Spreadsheet formats we recognise by name but cannot/do not read. */
const KNOWN_UNSUPPORTED = /\.(xlsm|xlsb|xls|ods)$/i;

/**
 * Pick the `RowSource` for an upload. Extension wins; then MIME type; then a
 * clear error for a known spreadsheet format; otherwise CSV (unchanged
 * behaviour for extensionless / unknown uploads).
 */
export function resolveRowSource(filename: string, contentType?: string | null): RowSource {
  const name = filename.trim().toLowerCase();

  const byExtension = REGISTRY.find((source) =>
    source.extensions.some((extension) => name.endsWith(extension)),
  );
  if (byExtension) return byExtension;

  if (contentType) {
    const mime = contentType.split(";")[0]!.trim().toLowerCase();
    const byMime = REGISTRY.find((source) => source.mimeTypes.includes(mime));
    if (byMime) return byMime;
  }

  if (KNOWN_UNSUPPORTED.test(name)) {
    throw new ImportFileError(
      "unsupported_format",
      "This spreadsheet format isn't supported — only .csv and .xlsx are accepted " +
        "(.xls, .xlsm, and .ods are not). Open the file and \"Save As\" .xlsx or .csv, " +
        "then upload that.",
    );
  }

  return csvRowSource;
}
