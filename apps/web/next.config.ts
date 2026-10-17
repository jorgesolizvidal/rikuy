import type { NextConfig } from "next";

/**
 * Baseline security headers. A full Content-Security-Policy is introduced with the portal
 * (P3), once map tiles, Storage CDN and the 360°/3D viewers are known origins.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self)" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  transpilePackages: ["@rikuy/config", "@rikuy/core", "@rikuy/ui"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
