import { CSRF_HEADER_NAME } from "@/server/auth/config";
import { clientEnv } from "@/server/config/env";

/**
 * CSRF defence for custom mutating route handlers.
 *
 * Layer 1 — origin check: the request's `Origin` (or `Referer`) must match the
 * app's own origin.
 * Layer 2 — double-submit token: a non-httpOnly `taek_csrf` cookie whose value
 * must be echoed in the `x-csrf-token` header (or a `csrfToken` form field).
 *
 * Server Actions are separately protected by Next.js's built-in Origin/Host
 * check; this helper is for hand-written route handlers.
 */

export class CsrfError extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = "CsrfError";
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function allowedOrigins(): string[] {
  const origins = new Set<string>();
  try {
    origins.add(new URL(clientEnv.NEXT_PUBLIC_APP_URL).origin);
  } catch {
    /* ignore malformed configured URL */
  }
  return [...origins];
}

export function assertSameOrigin(request: Request): void {
  if (SAFE_METHODS.has(request.method)) return;

  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const candidate = origin ?? (referer ? safeOrigin(referer) : null);

  if (!candidate) {
    throw new CsrfError("Missing Origin/Referer on a state-changing request.");
  }

  const permitted = new Set([...allowedOrigins(), safeOrigin(request.url)].filter(Boolean));
  if (!permitted.has(candidate)) {
    throw new CsrfError("Cross-origin request rejected.");
  }
}

export async function assertCsrfToken(
  request: Request,
  cookieToken: string | undefined,
): Promise<void> {
  if (SAFE_METHODS.has(request.method)) return;
  if (!cookieToken) throw new CsrfError("Missing CSRF cookie.");

  let submitted = request.headers.get(CSRF_HEADER_NAME);
  if (!submitted) {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("form")) {
      const form = await request.clone().formData();
      const field = form.get("csrfToken");
      submitted = typeof field === "string" ? field : null;
    }
  }

  if (!submitted || submitted !== cookieToken) {
    throw new CsrfError("CSRF token mismatch.");
  }
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
