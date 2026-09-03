import type { NextConfig } from "next";

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
  // NOTE: `output: "standalone"` is intentionally NOT set here. It is only useful
  // for the production Docker image (Phase 13), and when set it makes `next start`
  // print a warning and behave inconsistently — which affected the e2e runner.
  // Phase 13 re-introduces it together with the matching container start command
  // (`node .next/standalone/server.js` + copied `.next/static` / `public`).
  reactStrictMode: true,
  // Fail the production build on type errors instead of silently shipping.
  typescript: { ignoreBuildErrors: false },
  // Native modules that must not be bundled into server components.
  serverExternalPackages: ["@node-rs/argon2", "@prisma/client"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
