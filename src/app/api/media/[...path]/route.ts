import { getObjectStorage } from "@/server/storage";
import { isSafeStorageKey } from "@/server/storage/object-storage";

export const dynamic = "force-dynamic";

/**
 * Serves objects from the configured storage backend. In production with a real
 * CDN this route is unused (images are served directly from the bucket URL); it
 * exists so the local-filesystem backend can serve images in dev / tests.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await context.params;
  const key = path.join("/");

  if (!isSafeStorageKey(key)) {
    return new Response("Bad request", { status: 400 });
  }

  const object = await getObjectStorage().get(key);
  if (!object) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(object.body as BodyInit, {
    status: 200,
    headers: {
      "content-type": object.contentType,
      "cache-control": "public, max-age=86400",
      "content-length": String(object.body.byteLength),
    },
  });
}
