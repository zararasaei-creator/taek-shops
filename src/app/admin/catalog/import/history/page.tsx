import { redirect } from "next/navigation";
import Link from "next/link";
import { UserRole } from "@prisma/client";

import { Container } from "@/components/ui/container";
import { requireRole } from "@/server/auth";
import { requirePermission } from "@/server/auth/authorization";
import { listImportJobs } from "@/server/import/import-queries";

export const dynamic = "force-dynamic";

function actorLabel(createdBy: { email: string; firstName: string | null; lastName: string | null } | null) {
  if (!createdBy) return "—";
  const name = [createdBy.firstName, createdBy.lastName].filter(Boolean).join(" ");
  return name ? `${name} (${createdBy.email})` : createdBy.email;
}

export default async function ImportHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { user } = await requireRole(UserRole.STAFF);
  try {
    requirePermission(user, "import.run");
  } catch {
    redirect("/admin/catalog");
  }

  const params = await searchParams;
  const page = Math.max(Number(params.page ?? "1") || 1, 1);

  const { jobs, total, pageSize } = await listImportJobs(user, { page });
  const pages = Math.max(Math.ceil(total / pageSize), 1);

  const qs = (overrides: Record<string, string | undefined>) => {
    const next = new URLSearchParams({ ...(page > 1 ? { page: String(page) } : {}) });
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    return query ? `?${query}` : "";
  };

  return (
    <Container className="max-w-4xl py-10">
      <p className="text-sm">
        <Link className="text-blue-700 hover:underline" href="/admin/catalog/import">
          ← Back to import
        </Link>
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Import history</h1>
      <p className="mt-1 text-sm text-zinc-500">Every product import that has been run, newest first.</p>

      <div className="mt-6 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800">
            <tr>
              <th className="py-2 pr-4">File</th>
              <th className="py-2 pr-4">Format</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2 pr-4">Rows</th>
              <th className="py-2 pr-4">C / U / S / F</th>
              <th className="py-2 pr-4">By</th>
              <th className="py-2 pr-4">When</th>
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-4 text-zinc-500">
                  No imports yet.
                </td>
              </tr>
            ) : (
              jobs.map((job) => (
                <tr key={job.id} className="border-b border-zinc-100 dark:border-zinc-900">
                  <td className="py-2 pr-4">
                    <Link
                      className="text-blue-700 hover:underline"
                      href={`/admin/catalog/import/history/${job.id}`}
                    >
                      {job.originalFilename}
                    </Link>
                  </td>
                  <td className="py-2 pr-4">{job.sourceFormat}</td>
                  <td className="py-2 pr-4">{job.status}</td>
                  <td className="py-2 pr-4">{job.totalRows}</td>
                  <td className="py-2 pr-4 font-mono text-xs">
                    {job.createdRows}/{job.updatedRows}/{job.skippedRows}/{job.failedRows}
                  </td>
                  <td className="py-2 pr-4">{actorLabel(job.createdBy)}</td>
                  <td className="py-2 pr-4 text-zinc-500">
                    {job.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-sm text-zinc-500">
        {total} import(s){" · "}
        {pages > 1 ? (
          <>
            page {page} / {pages}{" "}
            {page > 1 ? (
              <Link className="text-blue-700" href={qs({ page: String(page - 1) })}>
                ← prev
              </Link>
            ) : null}{" "}
            {page < pages ? (
              <Link className="text-blue-700" href={qs({ page: String(page + 1) })}>
                next →
              </Link>
            ) : null}
          </>
        ) : null}
      </p>
    </Container>
  );
}
