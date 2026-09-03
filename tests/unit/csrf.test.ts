// @vitest-environment node
import { describe, expect, it } from "vitest";

import { CsrfError, assertCsrfToken, assertSameOrigin } from "@/lib/http/csrf";

const APP_ORIGIN = "http://localhost:3000";

function request(init: {
  method?: string;
  origin?: string | null;
  referer?: string | null;
  headers?: Record<string, string>;
  url?: string;
}): Request {
  const headers = new Headers(init.headers ?? {});
  if (init.origin) headers.set("origin", init.origin);
  if (init.referer) headers.set("referer", init.referer);
  return new Request(init.url ?? `${APP_ORIGIN}/api/auth/login`, {
    method: init.method ?? "POST",
    headers,
  });
}

describe("assertSameOrigin", () => {
  it("passes for a same-origin request", () => {
    expect(() => assertSameOrigin(request({ origin: APP_ORIGIN }))).not.toThrow();
  });

  it("passes safe methods regardless of origin", () => {
    expect(() =>
      assertSameOrigin(request({ method: "GET", origin: "https://evil.example" })),
    ).not.toThrow();
  });

  it("rejects a cross-origin state-changing request", () => {
    expect(() => assertSameOrigin(request({ origin: "https://evil.example" }))).toThrow(CsrfError);
  });

  it("rejects a mutating request with no Origin or Referer", () => {
    expect(() => assertSameOrigin(request({}))).toThrow(CsrfError);
  });

  it("falls back to Referer when Origin is absent", () => {
    expect(() => assertSameOrigin(request({ referer: `${APP_ORIGIN}/login` }))).not.toThrow();
  });
});

describe("assertCsrfToken (double-submit)", () => {
  it("passes when the header matches the cookie", async () => {
    await expect(
      assertCsrfToken(request({ headers: { "x-csrf-token": "abc123" } }), "abc123"),
    ).resolves.toBeUndefined();
  });

  it("rejects when the cookie is missing", async () => {
    await expect(
      assertCsrfToken(request({ headers: { "x-csrf-token": "abc123" } }), undefined),
    ).rejects.toBeInstanceOf(CsrfError);
  });

  it("rejects when the header is missing or mismatched", async () => {
    await expect(assertCsrfToken(request({}), "abc123")).rejects.toBeInstanceOf(CsrfError);
    await expect(
      assertCsrfToken(request({ headers: { "x-csrf-token": "nope" } }), "abc123"),
    ).rejects.toBeInstanceOf(CsrfError);
  });

  it("ignores safe methods", async () => {
    await expect(assertCsrfToken(request({ method: "GET" }), undefined)).resolves.toBeUndefined();
  });
});
