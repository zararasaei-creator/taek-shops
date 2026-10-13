// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";

import { proxy } from "@/proxy";

/**
 * Regression for a real bug found via a real-browser reproduction (Phase 9
 * manual image review): the CSP's `connect-src` never included the
 * S3-compatible storage origin, so the browser silently blocked the
 * presigned-upload PUT as a CSP violation before any network request was
 * even attempted — `img-src` had the same gap for rendering finalized
 * images. Neither the local-filesystem e2e path (never leaves `'self'`)
 * nor Node-based `fetch()` in integration tests (CSP is a browser-only
 * enforcement mechanism) could ever have caught this — only a real browser
 * exercising a real presigned URL does, which is why this is a targeted
 * header assertion on `proxy.ts`'s own CSP-building logic, not a duplicate
 * of the storage/finalize tests elsewhere.
 */

function cspDirective(policy: string, name: string): string {
  const directive = policy.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `));
  if (!directive) throw new Error(`CSP has no "${name}" directive: ${policy}`);
  return directive;
}

function cspFor(url = "http://localhost:3000/"): string {
  const response = proxy(new NextRequest(new URL(url)));
  const policy = response.headers.get("Content-Security-Policy");
  if (!policy) throw new Error("proxy() response has no Content-Security-Policy header");
  return policy;
}

describe("Content-Security-Policy allows the configured S3-compatible storage origin", () => {
  const originalEndpoint = process.env.S3_ENDPOINT;
  const originalPublicBaseUrl = process.env.S3_PUBLIC_BASE_URL;

  afterEach(() => {
    if (originalEndpoint === undefined) delete process.env.S3_ENDPOINT;
    else process.env.S3_ENDPOINT = originalEndpoint;
    if (originalPublicBaseUrl === undefined) delete process.env.S3_PUBLIC_BASE_URL;
    else process.env.S3_PUBLIC_BASE_URL = originalPublicBaseUrl;
  });

  it("allows connect-src (presigned PUT) and img-src (rendering) to reach the storage origin when S3_* is configured", () => {
    process.env.S3_ENDPOINT = "http://localhost:9000";
    process.env.S3_PUBLIC_BASE_URL = "http://localhost:9000";
    const policy = cspFor();
    expect(cspDirective(policy, "connect-src")).toContain("http://localhost:9000");
    expect(cspDirective(policy, "img-src")).toContain("http://localhost:9000");
  });

  it("img-src falls back to S3_ENDPOINT's origin when S3_PUBLIC_BASE_URL is unset — matches S3ObjectStorage.publicUrl()'s own fallback", () => {
    process.env.S3_ENDPOINT = "http://localhost:9000";
    delete process.env.S3_PUBLIC_BASE_URL;
    const policy = cspFor();
    expect(cspDirective(policy, "img-src")).toContain("http://localhost:9000");
  });

  it("a different S3_PUBLIC_BASE_URL (e.g. a CDN in front of S3) is used for img-src independently of S3_ENDPOINT", () => {
    process.env.S3_ENDPOINT = "https://s3.us-east-1.amazonaws.com";
    process.env.S3_PUBLIC_BASE_URL = "https://cdn.example.com";
    const policy = cspFor();
    expect(cspDirective(policy, "connect-src")).toContain("https://s3.us-east-1.amazonaws.com");
    expect(cspDirective(policy, "img-src")).toContain("https://cdn.example.com");
    expect(cspDirective(policy, "img-src")).not.toContain("s3.us-east-1.amazonaws.com");
  });

  it("adds no extra origin — and does not weaken the existing policy — when no S3_* is configured (local-filesystem backend)", () => {
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_PUBLIC_BASE_URL;
    const policy = cspFor();
    expect(cspDirective(policy, "connect-src")).toBe("connect-src 'self' https://api.stripe.com");
    expect(cspDirective(policy, "img-src")).toBe("img-src 'self' data: blob: https://*.stripe.com");
  });
});
