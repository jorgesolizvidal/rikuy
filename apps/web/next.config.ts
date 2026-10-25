import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type { NextConfig } from "next";

const require = createRequire(import.meta.url);
const versionOf = (packageJson: string) =>
  (JSON.parse(readFileSync(packageJson, "utf8")) as { version: string }).version;
const maplibreVersion = versionOf(require.resolve("maplibre-gl/package.json"));
// three does not export its package.json: found from its main entry (build/three.cjs).
const threeVersion = versionOf(join(dirname(require.resolve("three")), "..", "package.json"));

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

/**
 * The commit a deployment was built from (Vercel sets it at build time). Lets the
 * post-deploy Lighthouse job wait until production serves the commit it should measure.
 */
const buildVersion = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12);
const versionHeaders = buildVersion ? [{ key: "X-Rikuy-Version", value: buildVersion }] : [];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  transpilePackages: ["@rikuy/config", "@rikuy/core", "@rikuy/ui"],
  // The GLB pipeline (job runner) loads WebAssembly from these packages at run time: kept as
  // node_modules (traced into the function) instead of bundled.
  serverExternalPackages: ["ktx2-encoder", "draco3dgltf", "gltf-validator", "meshoptimizer"],
  // Map worker and KTX2 transcoder are served from public/vendor/<package>/<version>/.
  env: { NEXT_PUBLIC_MAPLIBRE_VERSION: maplibreVersion, NEXT_PUBLIC_THREE_VERSION: threeVersion },
  async headers() {
    return [
      { source: "/:path*", headers: [...securityHeaders, ...versionHeaders] },
      {
        source: "/vendor/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

export default nextConfig;
