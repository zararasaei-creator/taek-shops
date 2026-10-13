import type { NextConfig } from "next";

/**
 * `next/image` remote patterns — restricted to exactly the configured
 * object-storage public URL (real S3, or local MinIO in dev), never a
 * wildcard host. When S3 isn't configured (local-filesystem backend), no
 * pattern is needed: images are served same-origin from `GET /api/media`.
 * A local MinIO URL (`http://localhost:9000/...`) is a development
 * convenience only — it is NOT a production CDN; a real deployment must
 * set `S3_PUBLIC_BASE_URL` to that CDN's own URL, which this same
 * allowlist logic will then restrict to.
 */
function storageRemotePatterns(): NonNullable<NextConfig["images"]>["remotePatterns"] {
  const raw = process.env.S3_PUBLIC_BASE_URL || process.env.S3_ENDPOINT;
  if (!raw) return [];
  try {
    const url = new URL(raw);
    return [
      {
        protocol: url.protocol.replace(":", "") as "http" | "https",
        hostname: url.hostname,
        port: url.port || "",
        pathname: "/**",
      },
    ];
  } catch {
    return [];
  }
}

/**
 * Static security headers applied to every response. The per-request,
 * nonce-based Content-Security-Policy and HSTS are added in `src/proxy.ts`
 * (they need request context / environment awareness).
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  },
];

const nextConfig: NextConfig = {
  // NOTE: `output: "standalone"` is intentionally NOT set, and Phase 13's production
  // image (Dockerfile) does not use it: its traced bundle omits what the job scripts
  // need (`tsx`, `src/`), and it makes `next start` print a warning and behave
  // inconsistently (it affected the e2e runner). The image runs `next start` on the
  // normal `.next` output instead — see docs/deployment.md.
  reactStrictMode: true,
  // The e2e webServer (playwright.config.ts) sets E2E_DIST_DIR so its own
  // `next build && next start` writes to a separate directory instead of the
  // `.next` a concurrently-running `next dev` is using — a shared dist dir
  // corrupted the dev server's Turbopack cache once already. Unset for every
  // normal `dev`/`build`/`start` invocation, so behavior there is unchanged.
  distDir: process.env.E2E_DIST_DIR || ".next",
  // Fail the production build on type errors instead of silently shipping.
  typescript: { ignoreBuildErrors: false },
  // Native modules that must not be bundled into server components.
  serverExternalPackages: ["@node-rs/argon2", "@prisma/client"],
  images: {
    remotePatterns: storageRemotePatterns(),
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
