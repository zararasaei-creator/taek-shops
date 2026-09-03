import { redirect } from "next/navigation";
import { UserRole } from "@prisma/client";

import { Container } from "@/components/ui/container";
import { requireRole } from "@/server/auth";
import { requirePermission } from "@/server/auth/authorization";
import { prisma } from "@/server/db/client";
import { serverEnv } from "@/server/config/env";
import { ImportRunner } from "@/app/admin/catalog/import/import-runner";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const { user } = await requireRole(UserRole.STAFF);
  try {
    requirePermission(user, "import.run");
  } catch {
    redirect("/admin/catalog");
  }

  const recent = await prisma.importJob.findMany({
    where: { type: "PRODUCT" },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      originalFilename: true,
      status: true,
      totalRows: true,
      createdRows: true,
      updatedRows: true,
      skippedRows: true,
      failedRows: true,
      createdAt: true,
    },
  });

  return (
    <Container className="max-w-3xl py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Import products (CSV)</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Upload a CSV, review the dry-run preview, then commit. Nothing is written until you commit.
        Max {serverEnv.IMPORT_MAX_FILE_SIZE_BYTES.toLocaleString()} bytes /{" "}
        {serverEnv.IMPORT_MAX_ROW_COUNT.toLocaleString()} rows.
      </p>
      <p className="mt-2 text-sm">
        <a className="text-blue-700 hover:underline" href="/api/admin/import/products/template">
          Download the CSV template
        </a>
      </p>

      <ImportRunner />

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Recent imports</h2>
        <table className="mt-2 w-full text-left text-sm">
          <thead className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800">
            <tr>
              <th className="py-2 pr-3">File</th>
              <th className="py-2 pr-3">Status</th>
              <th className="py-2 pr-3">Rows</th>
              <th className="py-2 pr-3">C / U / S / F</th>
              <th className="py-2 pr-3">When</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((job) => (
              <tr key={job.id} className="border-b border-zinc-100 dark:border-zinc-900">
                <td className="py-1 pr-3">{job.originalFilename}</td>
                <td className="py-1 pr-3">{job.status}</td>
                <td className="py-1 pr-3">{job.totalRows}</td>
                <td className="py-1 pr-3 font-mono text-xs">
                  {job.createdRows}/{job.updatedRows}/{job.skippedRows}/{job.failedRows}
                </td>
                <td className="py-1 pr-3 text-zinc-500">
                  {job.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                </td>
              </tr>
            ))}
            {recent.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-3 text-zinc-500">
                  No imports yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </Container>
  );
}
