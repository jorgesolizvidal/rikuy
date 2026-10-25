// Copies three.js's Basis Universal transcoder (KTX2 textures of the 3D models) to
// public/vendor/three/<version>/basis/, so the viewer loads it from our own origin.
// Generated, versioned and git-ignored; runs before `next dev` and `next build`.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// three does not export its package.json: found from its main entry (build/three.cjs).
const pkgPath = join(dirname(require.resolve("three")), "..", "package.json");
const { version } = JSON.parse(readFileSync(pkgPath, "utf8"));
const source = join(dirname(pkgPath), "examples", "jsm", "libs", "basis");
const target = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
  "vendor",
  "three",
  version,
  "basis",
);

mkdirSync(target, { recursive: true });
for (const file of ["basis_transcoder.js", "basis_transcoder.wasm"]) {
  if (!existsSync(join(source, file))) throw new Error(`three ${version}: ${file} not found`);
  copyFileSync(join(source, file), join(target, file));
}
console.log(`three ${version} Basis transcoder → public/vendor/three/${version}/basis/`);
