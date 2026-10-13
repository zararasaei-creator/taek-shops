import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { isAuthError } from "@/server/auth/errors";
import { isCatalogError } from "@/server/catalog/errors";
import { isImportFileError } from "@/server/import/errors";
import { CsrfError } from "@/lib/http/csrf";
import { errorFields, logError } from "@/server/observability/logger";

/**
 * Uniform JSON error responses for route handlers. Only safe, typed errors are
 * surfaced with detail; anything else becomes a generic 500 so internals never
 * leak to the client — and is logged server-side as ONE structured event
 * (`api.unhandled_error`: request method + path, an optional proxy-supplied request
 * id, and the error's class name + category), never the raw error object, message,
 * stack or cause (those can echo secrets, SQL, or customer data).
 */

/** Non-sensitive request facts that make an unexpected failure traceable. */
export interface ErrorContext {
  method?: string;
  path?: string;
  requestId?: string;
}

/**
 * Method, path (no query string — it can carry tokens) and the reverse proxy's
 * `x-request-id` when one was supplied and is a plain identifier. No id is invented
 * here: the app has no request-scoped correlation id of its own.
 */
export function errorContextOf(request: Request | undefined): ErrorContext {
  if (!request) return {};
  const context: ErrorContext = { method: request.method };
  try {
    context.path = new URL(request.url).pathname;
  } catch {
    /* unparseable URL: log without a path */
  }
  const requestId = request.headers.get("x-request-id");
  if (requestId && /^[A-Za-z0-9._-]{8,64}$/.test(requestId)) context.requestId = requestId;
  return context;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export function apiError(code: string, message: string, status: number, details?: unknown) {
  const body: ApiErrorBody = { error: { code, message, ...(details ? { details } : {}) } };
  return NextResponse.json(body, { status });
}

export function toErrorResponse(error: unknown, context: ErrorContext = {}) {
  if (isAuthError(error)) {
    const headers =
      error.code === "rate_limited" && "retryAfterSeconds" in error
        ? { "retry-after": String((error as { retryAfterSeconds: number }).retryAfterSeconds) }
        : undefined;
    const details =
      error.code === "weak_password" && "reasons" in error
        ? (error as { reasons: string[] }).reasons
        : undefined;
    const response = apiError(error.code, error.publicMessage, error.status, details);
    if (headers) response.headers.set("retry-after", headers["retry-after"]);
    return response;
  }

  if (isCatalogError(error)) {
    return apiError(error.code, error.publicMessage, error.status, error.details);
  }

  if (isImportFileError(error)) {
    return apiError(error.code, error.publicMessage, error.status);
  }

  if (error instanceof CsrfError) {
    return apiError("csrf", "Request rejected for security reasons.", 403);
  }

  if (error instanceof ZodError) {
    return apiError("validation", "Invalid request.", 422, error.flatten());
  }

  logError("api.unhandled_error", { ...context, ...errorFields(error) });
  return apiError("internal", "Something went wrong.", 500);
}

/** Wrap a route handler so thrown errors become uniform responses. */
export function route<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return toErrorResponse(error, errorContextOf(args.find((arg): arg is Request => arg instanceof Request)));
    }
  };
}
