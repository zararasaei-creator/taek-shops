import { getCurrentUser } from "@/server/auth";
import { buildImportErrorReportCsv } from "@/server/import/import-queries";
import { route } from "@/lib/http/api-response";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/import/products/[jobId]/errors — download the failed rows
 * of one import job as a CSV attachment. Read-only; `import.run` is
 * enforced independently inside `buildImportErrorReportCsv` itself, not
 * just here (see that module's doc comment).
 */
export const GET = route(async (_request: Request, context: { params: Promise<{ jobId: string }> }) => {
  const { jobId } = await context.params;
  const actor = await getCurrentUser();
  const report = await buildImportErrorReportCsv(actor, jobId);

  return new Response(report.csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${report.filename}"`,
      "cache-control": "no-store, private",
    },
  });
});
