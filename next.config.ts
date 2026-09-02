import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produce a minimal, self-contained server bundle for Docker/production deploys.
  output: "standalone",
  reactStrictMode: true,
  // Fail the production build on type errors instead of silently shipping.
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
