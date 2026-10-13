import { NextResponse } from "next/server";

import { getCurrentUser } from "@/server/auth";
import { uploadProductImage, MAX_IMAGE_BYTES } from "@/server/catalog/image-service";
import { CatalogValidationError } from "@/server/catalog/errors";
import { route } from "@/lib/http/api-response";
import { guardMutation } from "@/lib/http/guard-request";
import { getRequestMeta } from "@/lib/http/request-meta";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/catalog/products/[id]/images — multipart form-data with a
 * `file` field. Single-step upload used ONLY by the local-filesystem storage
 * backend (which has no direct-upload endpoint — `createSignedUpload`
 * returns `null`). The S3-compatible backend (real S3 / local MinIO) never
 * calls this route: the browser uploads directly to storage via a presigned
 * URL instead (`createImageUploadSlotAction` /
 * `finalizeImageUploadAction`). Authorization and the real, byte-level
 * validation both happen inside `uploadProductImage` — never trust the
 * client's claimed content-type.
 */
export const POST = route(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  await guardMutation(request);
  const { id: productId } = await context.params;
  const actor = await getCurrentUser();
  const meta = getRequestMeta(request);

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new CatalogValidationError("Expected a `file` field with an image upload.");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new CatalogValidationError(`Image must not exceed ${MAX_IMAGE_BYTES} bytes.`);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const image = await uploadProductImage(
    actor,
    productId,
    { filename: file.name || "upload", contentType: file.type || "application/octet-stream", bytes, ...meta },
  );

  return NextResponse.json({ id: image.id });
});
