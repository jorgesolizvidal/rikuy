import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { NextConfig } from "next";

const require = createRequire(import.meta.url);
const maplibreVersion = (
  JSON.parse(readFileSync(require.resolve("maplibre-gl/package.json"), "utf8")) as {
    version: string;
  }
).version;

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
  // The map worker is served from public/vendor/maplibre-gl/<version>/ (versioned path).
  env: { NEXT_PUBLIC_MAPLIBRE_VERSION: maplibreVersion },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      {
        source: "/vendor/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

export default nextConfig;
