import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { UserRole } from "@prisma/client";

import { Container } from "@/components/ui/container";
import { requireRole } from "@/server/auth";
import { requirePermission } from "@/server/auth/authorization";
import { ImportFileError } from "@/server/import/errors";
import { getImportJob, listFailedImportRows } from "@/server/import/import-queries";

export const dynamic = "force-dynamic";

const UNFINISHED_STATUSES = new Set(["PENDING", "VALIDATING", "VALIDATED", "PROCESSING"]);

function actorLabel(createdBy: { email: string; firstName: string | null; lastName: string | null } | null) {
  if (!createdBy) return "—";
  const name = [createdBy.firstName, createdBy.lastName].filter(Boolean).join(" ");
  return name ? `${name} (${createdBy.email})` : createdBy.email;
}

export default async function ImportHistoryDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { user } = await requireRole(UserRole.STAFF);
  try {
    requirePermission(user, "import.run");
  } catch {
    redirect("/admin/catalog");
  }

  const { id } = await params;
  let job;
  try {
    job = await getImportJob(user, id);
  } catch (error) {
    if (error instanceof ImportFileError && error.code === "job_not_found") notFound();
    throw error;
  }

  const rowParams = await searchParams;
  const page = Math.max(Number(rowParams.page ?? "1") || 1, 1);
  const { rows, total, pageSize } = await listFailedImportRows(user, id, { page });
  const pages = Math.max(Math.ceil(total / pageSize), 1);

  const isUnfinished = UNFINISHED_STATUSES.has(job.status);

  return (
    <Container className="max-w-4xl py-10">
      <p className="text-sm">
        <Link className="text-blue-700 hover:underline" href="/admin/catalog/import/history">
          ← Back to import history
        </Link>
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{job.originalFilename}</h1>

      {isUnfinished ? (
        <p className="mt-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          This import has not finished — current status: <strong>{job.status}</strong>. Rows shown
          below are whatever has been validated so far; the counts may still change.
        </p>
      ) : null}

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-zinc-500">Status</dt>
          <dd>{job.status}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">Format</dt>
          <dd>{job.sourceFormat}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">Total rows</dt>
          <dd>{job.totalRows}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">Created / Updated / Skipped</dt>
          <dd>
            {job.createdRows} / {job.updatedRows} / {job.skippedRows}
          </dd>
        </div>
        <div>
          <dt className="text-zinc-500">Failed</dt>
          <dd>{job.failedRowCount}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">Run by</dt>
          <dd>{actorLabel(job.createdBy)}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">Started</dt>
          <dd>{job.createdAt.toISOString().slice(0, 16).replace("T", " ")}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">Completed</dt>
          <dd>{job.completedAt ? job.completedAt.toISOString().slice(0, 16).replace("T", " ") : "—"}</dd>
        </div>
      </dl>

      <div className="mt-8 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Failed rows</h2>
        {job.failedRowCount > 0 ? (
          <a
            className="text-sm text-blue-700 hover:underline"
            href={`/api/admin/import/products/${job.id}/errors`}
          >
            Download error report (CSV)
          </a>
        ) : null}
      </div>

      {job.failedRowCount === 0 ? (
        <p className="mt-2 text-sm text-zinc-500">No failed rows for this import.</p>
      ) : (
        <>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800">
                <tr>
                  <th className="py-2 pr-4">Row</th>
                  <th className="py-2 pr-4">SKU</th>
                  <th className="py-2 pr-4">Errors</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-zinc-100 dark:border-zinc-900">
                    <td className="py-2 pr-4 align-top">{row.rowNumber}</td>
                    <td className="py-2 pr-4 align-top font-mono">{row.sku ?? "—"}</td>
                    <td className="py-2 pr-4 align-top">
                      {row.errors.map((e, i) => (
                        <div key={i}>
                          {e.column ? `${e.column}: ` : ""}
                          {e.message}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-4 text-sm text-zinc-500">
            {total} failed row(s){" · "}
            {pages > 1 ? (
              <>
                page {page} / {pages}{" "}
                {page > 1 ? (
                  <Link className="text-blue-700" href={`?page=${page - 1}`}>
                    ← prev
                  </Link>
                ) : null}{" "}
                {page < pages ? (
                  <Link className="text-blue-700" href={`?page=${page + 1}`}>
                    next →
                  </Link>
                ) : null}
              </>
            ) : null}
          </p>
        </>
      )}
    </Container>
  );
}
