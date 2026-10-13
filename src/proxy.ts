import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE_NAME } from "@/server/auth/config";

/**
 * Edge proxy (Next 16's renamed Middleware). Two concerns only:
 *
 * 1. Security headers, including a per-request nonce'd Content-Security-Policy.
 * 2. A *coarse, optimistic* gate: send anyone with no session cookie away from
 *    `/admin`. This is UX, not security — every privileged operation is
 *    re-checked server-side against the database (see `src/server/auth`).
 *
 * The proxy runs on the Edge runtime: no database, no Node crypto beyond Web
 * Crypto, no Prisma. Real session validation happens in route handlers / RSCs.
 */

const PROTECTED_PREFIXES = ["/admin"];

/** The origin (scheme+host+port) of a configured absolute URL, or `null` if unset/unparseable. */
function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function buildCsp(nonce: string, isDev: boolean): string {
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    // Host allow-lists are ignored by browsers that honour 'strict-dynamic';
    // kept for older browsers that load Stripe.js by URL.
    "https://js.stripe.com",
    isDev ? "'unsafe-eval'" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // The S3-compatible image storage backend (real S3 or local MinIO — see
  // `s3-object-storage.ts`) is a THIRD-PARTY origin from the browser's
  // point of view, not `'self'`: `createProductImageUploadSlot` hands the
  // browser a presigned URL and the browser PUTs the file bytes straight
  // to `S3_ENDPOINT`, bypassing this app server entirely (Phase 9's whole
  // point); rendered images are fetched from `S3_PUBLIC_BASE_URL` (or
  // `S3_ENDPOINT` if that's unset — the same fallback
  // `S3ObjectStorage.publicUrl()` itself uses). Both are `null`, and these
  // directives fall back to their pre-Phase-9 values unchanged, when the
  // local-filesystem backend is configured instead (no `S3_*`). Without
  // this, the browser silently blocks the presigned PUT as a CSP
  // violation before any network request is even attempted — found via a
  // real-browser reproduction; Node-based `fetch()` in integration tests
  // never exercises CSP (it's a browser-only enforcement mechanism), and
  // the local-filesystem e2e path never leaves `'self'`, so neither test
  // suite could have caught this.
  const uploadOrigin = originOf(process.env.S3_ENDPOINT);
  const publicOrigin = originOf(process.env.S3_PUBLIC_BASE_URL) ?? uploadOrigin;

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    // TODO(phase 4): tighten to nonce/hash once the component system is settled.
    "style-src 'self' 'unsafe-inline'",
    ["img-src 'self' data: blob: https://*.stripe.com", publicOrigin].filter(Boolean).join(" "),
    "font-src 'self'",
    // Stripe.js / Payment Element talk to api.stripe.com and load an iframe
    // from js.stripe.com + hooks.stripe.com (Phase 7).
    ["connect-src 'self' https://api.stripe.com", uploadOrigin].filter(Boolean).join(" "),
    "frame-src https://js.stripe.com https://hooks.stripe.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

function applyDynamicHeaders(response: NextResponse, csp: string, isProd: boolean): void {
  // Static headers (X-Frame-Options, Referrer-Policy, …) come from next.config.
  response.headers.set("Content-Security-Policy", csp);
  if (isProd) {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload",
    );
  }
}

export function proxy(request: NextRequest): NextResponse {
  const isDev = process.env.NODE_ENV === "development";
  const isProd = process.env.NODE_ENV === "production";
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const csp = buildCsp(nonce, isDev);

  const { pathname } = request.nextUrl;
  const needsAuth = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  const hasSessionCookie = Boolean(request.cookies.get(SESSION_COOKIE_NAME)?.value);

  if (needsAuth && !hasSessionCookie) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname)}`;
    const redirect = NextResponse.redirect(url);
    applyDynamicHeaders(redirect, csp, isProd);
    return redirect;
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  applyDynamicHeaders(response, csp, isProd);
  return response;
}

export const config = {
  // Everything except Next internals and common static files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
};
