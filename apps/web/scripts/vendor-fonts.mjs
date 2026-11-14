// Copies the portal themes' fonts (ADR-061) to public/vendor/fonts/<package>/<version>/, so
// each portal preloads only its theme's font, from its own origin, at a stable address.
// Generated, versioned and git-ignored; runs before `next dev` and `next build`.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const FONTS = [
  ["plus-jakarta-sans", "plus-jakarta-sans-latin-wght-normal.woff2"],
  ["bricolage-grotesque", "bricolage-grotesque-latin-wght-normal.woff2"],
];

for (const [name, file] of FONTS) {
  const pkgPath = require.resolve(`@fontsource-variable/${name}/package.json`);
  const { version } = JSON.parse(readFileSync(pkgPath, "utf8"));
  const source = join(dirname(pkgPath), "files", file);
  if (!existsSync(source))
    throw new Error(`@fontsource-variable/${name} ${version}: ${file} not found`);
  const target = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "public",
    "vendor",
    "fonts",
    name,
    version,
  );
  mkdirSync(target, { recursive: true });
  copyFileSync(source, join(target, file));
  console.log(`${name} ${version} → public/vendor/fonts/${name}/${version}/`);
}
