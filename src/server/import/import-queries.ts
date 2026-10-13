import type { ImportJobSourceFormat, ImportJobStatus, PrismaClient } from "@prisma/client";
import { ImportRowStatus, Prisma } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { requirePermission, type AuthUser } from "@/server/auth/authorization";
import { serverEnv } from "@/server/config/env";
import { ImportFileError, type RowError } from "@/server/import/errors";
import { toCsv } from "@/server/import/cell-sanitize";

/**
 * Read-only import history (Phase 10 sub-milestone): browsing past
 * `ImportJob`/`ImportJobRow` records and exporting a failed-rows CSV. No
 * new tables, no change to `previewImport`/`commitImport` in
 * `product-import-service.ts` — this module only ever reads.
 *
 * Authorization is enforced independently in EVERY exported function here
 * (never assumed from a caller's own check) — the same `import.run`
 * permission that gates running an import also gates viewing its history,
 * consistent with there being no separate "import.read" permission in
 * `authorization.ts`.
 */

type Db = PrismaClient;
type Actor = AuthUser | null | undefined;

const JOBS_PAGE_SIZE = 20;
const FAILED_ROWS_PAGE_SIZE = 50;
/** A CSV export can never legitimately need more rows than a single import
 * file is allowed to have — reusing this existing, audited config value as
 * the hard ceiling avoids inventing a new one and bounds the export to a
 * known-safe amount of work regardless of how the count field reads. */
const MAX_EXPORTED_ROWS = serverEnv.IMPORT_MAX_ROW_COUNT;

export interface ImportJobSummary {
  id: string;
  originalFilename: string;
  sourceFormat: ImportJobSourceFormat;
  status: ImportJobStatus;
  mode: string | null;
  totalRows: number;
  createdRows: number;
  updatedRows: number;
  skippedRows: number;
  /** As stored on the job by `commitImport` — see `failedRowCount` on a
   * single job's detail for the ground-truth count instead; this field is
   * commit-time bookkeeping and is not reused for display. */
  failedRows: number;
  errorSummary: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  createdBy: { id: string; email: string; firstName: string | null; lastName: string | null } | null;
}

export interface ImportJobListPage {
  jobs: ImportJobSummary[];
  total: number;
  page: number;
  pageSize: number;
}

const JOB_SUMMARY_SELECT = {
  id: true,
  originalFilename: true,
  sourceFormat: true,
  status: true,
  mode: true,
  totalRows: true,
  createdRows: true,
  updatedRows: true,
  skippedRows: true,
  failedRows: true,
  errorSummary: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  createdBy: { select: { id: true, email: true, firstName: true, lastName: true } },
} satisfies Prisma.ImportJobSelect;

/**
 * Paginated, newest-first job history. `createdAt` alone is not unique
 * (two jobs can share a millisecond), so the sort carries `id` as a
 * stable secondary key — otherwise a row could be skipped or repeated
 * across pages when timestamps tie.
 */
export async function listImportJobs(
  actor: Actor,
  options: { page?: number } = {},
  db: Db = prisma,
): Promise<ImportJobListPage> {
  requirePermission(actor, "import.run");
  const pageSize = JOBS_PAGE_SIZE;
  const page = Math.max(options.page ?? 1, 1);

  const [jobs, total] = await Promise.all([
    db.importJob.findMany({
      where: { type: "PRODUCT" },
      select: JOB_SUMMARY_SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.importJob.count({ where: { type: "PRODUCT" } }),
  ]);

  return { jobs, total, page, pageSize };
}

export interface ImportJobDetail extends ImportJobSummary {
  /** The true count of rows currently `FAILED`, queried directly — not the
   * `failedRows` bookkeeping field above (see its own doc comment). */
  failedRowCount: number;
}

/** Throws `ImportFileError("job_not_found", …, 404)` if the job doesn't exist. */
export async function getImportJob(actor: Actor, importJobId: string, db: Db = prisma): Promise<ImportJobDetail> {
  requirePermission(actor, "import.run");
  const job = await db.importJob.findUnique({
    where: { id: importJobId },
    select: JOB_SUMMARY_SELECT,
  });
  if (!job) throw new ImportFileError("job_not_found", "Import job not found.", 404);

  const failedRowCount = await db.importJobRow.count({
    where: { importJobId, status: ImportRowStatus.FAILED },
  });

  return { ...job, failedRowCount };
}

export interface FailedImportRow {
  id: string;
  rowNumber: number;
  sku: string | null;
  errors: RowError[];
}

export interface FailedImportRowsPage {
  rows: FailedImportRow[];
  total: number;
  page: number;
  pageSize: number;
}

function toRowErrors(value: Prisma.JsonValue | null): RowError[] {
  if (!Array.isArray(value)) return [];
  return value as unknown as RowError[];
}

/**
 * Paginated failed rows for one job, ordered by their original row
 * number — already unique per job (`@@unique([importJobId, rowNumber])`),
 * so no secondary tie-breaker is needed here the way the job list needs one.
 */
export async function listFailedImportRows(
  actor: Actor,
  importJobId: string,
  options: { page?: number } = {},
  db: Db = prisma,
): Promise<FailedImportRowsPage> {
  requirePermission(actor, "import.run");
  // Confirms the job exists (and throws the same not-found error as
  // `getImportJob`) before paginating its rows, independent of whether the
  // caller already looked the job up.
  const exists = await db.importJob.findUnique({ where: { id: importJobId }, select: { id: true } });
  if (!exists) throw new ImportFileError("job_not_found", "Import job not found.", 404);

  const pageSize = FAILED_ROWS_PAGE_SIZE;
  const page = Math.max(options.page ?? 1, 1);
  const where = { importJobId, status: ImportRowStatus.FAILED };

  const [rows, total] = await Promise.all([
    db.importJobRow.findMany({
      where,
      select: { id: true, rowNumber: true, sku: true, errors: true },
      orderBy: { rowNumber: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.importJobRow.count({ where }),
  ]);

  return {
    rows: rows.map((r) => ({ id: r.id, rowNumber: r.rowNumber, sku: r.sku, errors: toRowErrors(r.errors) })),
    total,
    page,
    pageSize,
  };
}

const CELL_VALUES_KEY = "raw";

function originalValueFor(rawData: Prisma.JsonValue | null, column: string | null): string {
  if (!column || !rawData || typeof rawData !== "object" || Array.isArray(rawData)) return "";
  const cells = (rawData as Record<string, unknown>)[CELL_VALUES_KEY];
  if (!cells || typeof cells !== "object" || Array.isArray(cells)) return "";
  const value = (cells as Record<string, unknown>)[column];
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export interface ImportErrorReport {
  filename: string;
  csv: string;
  rowCount: number;
}

/**
 * Build a downloadable CSV of exactly this job's failed rows — one line per
 * (row, error) pair, since a single row can carry more than one error.
 * Every untrusted value (error message, original cell value, even the
 * filename baked into the response elsewhere) goes through the same
 * `toCsv`/formula-neutralization helpers the CSV importer and template use
 * — this file is itself a spreadsheet a person will open.
 *
 * Bounded: fetches in `FAILED_ROWS_PAGE_SIZE` pages up to
 * `MAX_EXPORTED_ROWS` total rows (== the importer's own per-file row cap,
 * so any legitimate job is fully covered) rather than one unbounded
 * `findMany` — an unbounded read here would scale with attacker-controlled
 * input (a very large, mostly-invalid import file) instead of a fixed cap.
 */
export async function buildImportErrorReportCsv(
  actor: Actor,
  importJobId: string,
  db: Db = prisma,
): Promise<ImportErrorReport> {
  requirePermission(actor, "import.run");
  const job = await db.importJob.findUnique({
    where: { id: importJobId },
    select: { id: true, originalFilename: true },
  });
  if (!job) throw new ImportFileError("job_not_found", "Import job not found.", 404);

  const header = ["row_number", "sku", "column", "error_code", "message", "original_value"];
  const csvRows: (string | number)[][] = [];
  let skip = 0;
  for (;;) {
    const rows = await db.importJobRow.findMany({
      where: { importJobId, status: ImportRowStatus.FAILED },
      select: { rowNumber: true, sku: true, errors: true, rawData: true },
      orderBy: { rowNumber: "asc" },
      skip,
      take: FAILED_ROWS_PAGE_SIZE,
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      const errors = toRowErrors(row.errors);
      const entries = errors.length > 0 ? errors : [{ column: null, code: "", message: "" } as RowError];
      for (const error of entries) {
        csvRows.push([
          row.rowNumber,
          row.sku ?? "",
          error.column ?? "",
          error.code,
          error.message,
          originalValueFor(row.rawData, error.column),
        ]);
      }
    }
    skip += rows.length;
    if (skip >= MAX_EXPORTED_ROWS || rows.length < FAILED_ROWS_PAGE_SIZE) break;
  }

  const safeName = job.originalFilename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "import";
  return {
    filename: `${safeName}-errors.csv`,
    csv: toCsv(header, csvRows),
    rowCount: csvRows.length,
  };
}
