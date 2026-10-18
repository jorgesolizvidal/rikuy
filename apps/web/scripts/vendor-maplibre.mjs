// Copies MapLibre's web worker files to public/vendor/maplibre-gl/<version>/ so the map
// can start its worker from our own origin (bundlers do not emit MapLibre 6's worker).
// Generated, versioned and git-ignored; runs before `next dev` and `next build`.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pkgPath = require.resolve("maplibre-gl/package.json");
const { version } = JSON.parse(readFileSync(pkgPath, "utf8"));
const source = join(dirname(pkgPath), "dist");
const target = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
  "vendor",
  "maplibre-gl",
  version,
);

mkdirSync(target, { recursive: true });
for (const file of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
  if (!existsSync(join(source, file))) throw new Error(`maplibre-gl ${version}: ${file} not found`);
  copyFileSync(join(source, file), join(target, file));
}
console.log(`maplibre-gl ${version} worker → public/vendor/maplibre-gl/${version}/`);
