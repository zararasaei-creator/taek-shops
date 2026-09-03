import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { isAuthError } from "@/server/auth/errors";
import { CsrfError } from "@/lib/http/csrf";

/**
 * Uniform JSON error responses for route handlers. Only safe, typed errors are
 * surfaced with detail; anything else becomes a generic 500 (and is logged
 * server-side) so internals never leak.
 */

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export function apiError(code: string, message: string, status: number, details?: unknown) {
  const body: ApiErrorBody = { error: { code, message, ...(details ? { details } : {}) } };
  return NextResponse.json(body, { status });
}

export function toErrorResponse(error: unknown) {
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

  if (error instanceof CsrfError) {
    return apiError("csrf", "Request rejected for security reasons.", 403);
  }

  if (error instanceof ZodError) {
    return apiError("validation", "Invalid request.", 422, error.flatten());
  }

  console.error("[api] unhandled error:", error);
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
      return toErrorResponse(error);
    }
  };
}
