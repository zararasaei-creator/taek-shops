/**
 * Best-effort extraction of client IP and user agent from a request, for audit
 * records and rate-limit keys. Never trusted for authorization.
 */
export interface RequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

export function getRequestMeta(request: Request): RequestMeta {
  const headers = request.headers;
  const forwardedFor = headers.get("x-forwarded-for");
  const ipAddress = forwardedFor?.split(",")[0]?.trim() || headers.get("x-real-ip")?.trim() || null;

  return {
    ipAddress: ipAddress && ipAddress.length <= 100 ? ipAddress : null,
    userAgent: headers.get("user-agent")?.slice(0, 400) ?? null,
  };
}
