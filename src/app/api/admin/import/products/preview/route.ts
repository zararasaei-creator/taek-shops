import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/auth";
import { previewImport } from "@/server/import/product-import-service";
import { ImportFileError } from "@/server/import/errors";
import { serverEnv } from "@/server/config/env";
import { route } from "@/lib/http/api-response";
import { guardMutation } from "@/lib/http/guard-request";
import { getRequestMeta } from "@/lib/http/request-meta";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/import/products/preview — multipart form-data with a `file`
 * field. Parses, validates, classifies, and persists an ImportJob. Writes NO
 * catalogue data (dry-run).
 */
export const POST = route(async (request: Request) => {
  await guardMutation(request);
  const actor = await getCurrentUser();
  const meta = getRequestMeta(request);

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new ImportFileError("unparseable", "Expected a `file` field with a CSV upload.");
  }
  if (file.size > serverEnv.IMPORT_MAX_FILE_SIZE_BYTES) {
    throw new ImportFileError(
      "file_too_large",
      `The file exceeds the ${serverEnv.IMPORT_MAX_FILE_SIZE_BYTES.toLocaleString()} byte limit.`,
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const preview = await previewImport(
    actor,
    { filename: file.name || "upload.csv", bytes, ...meta },
    undefined,
  );

  return NextResponse.json(preview);
});
