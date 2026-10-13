/**
 * Import errors. `ImportFileError` aborts the whole file; row-level problems are
 * collected as `RowError[]` and never thrown.
 */

export type ImportFileErrorCode =
  | "empty_file"
  | "file_too_large"
  | "too_many_rows"
  | "too_many_columns"
  | "too_many_archive_entries"
  | "archive_entry_too_large"
  | "archive_too_large"
  | "not_utf8"
  | "unparseable"
  | "missing_required_columns"
  | "duplicate_columns"
  | "no_data_rows"
  | "multiple_worksheets"
  | "unsupported_format"
  | "job_not_found"
  | "job_wrong_state";

export class ImportFileError extends Error {
  readonly code: ImportFileErrorCode;
  readonly status: number;
  readonly publicMessage: string;

  constructor(code: ImportFileErrorCode, publicMessage: string, status = 422) {
    super(publicMessage);
    this.name = "ImportFileError";
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

export interface RowError {
  column: string | null;
  code: string;
  message: string;
  value?: string | null;
}

export function isImportFileError(error: unknown): error is ImportFileError {
  return error instanceof ImportFileError;
}
