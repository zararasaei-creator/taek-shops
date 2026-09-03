import { getCurrentUser } from "@/server/auth";
import { requirePermission } from "@/server/auth/authorization";
import { buildProductImportTemplate } from "@/server/import/product-import-columns";
import { route } from "@/lib/http/api-response";

export const dynamic = "force-dynamic";

/** GET /api/admin/import/products/template — download the CSV template. */
export const GET = route(async () => {
  requirePermission(await getCurrentUser(), "import.run");
  return new Response(buildProductImportTemplate(), {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="taek-shops-product-import-template.csv"',
    },
  });
});
