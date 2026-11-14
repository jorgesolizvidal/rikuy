import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { THEME_STYLES } from "@rikuy/core";
import { beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const packageDir = (name: string) =>
  dirname(require.resolve(`@fontsource-variable/${name}/package.json`));
const versionOf = (name: string) =>
  (JSON.parse(readFileSync(join(packageDir(name), "package.json"), "utf8")) as { version: string })
    .version;

let fonts: typeof import("./theme-fonts");

beforeAll(async () => {
  // next.config.ts sets these at build time from the installed packages.
  process.env.NEXT_PUBLIC_JAKARTA_VERSION = versionOf("plus-jakarta-sans");
  process.env.NEXT_PUBLIC_BRICOLAGE_VERSION = versionOf("bricolage-grotesque");
  fonts = await import("./theme-fonts");
});

/** The file each theme points at, inside its installed package. */
function sourceOf(href: string): string {
  const match = /^\/vendor\/fonts\/([a-z-]+)\/(\d+\.\d+\.\d+)\/([a-z-]+\.woff2)$/.exec(href);
  if (!match) throw new Error(`unexpected font address ${href}`);
  const [, name = "", version, file = ""] = match;
  expect(version).toBe(versionOf(name));
  return join(packageDir(name), "files", file);
}

describe("theme fonts (ADR-061)", () => {
  it("each theme points at an installed, versioned file", () => {
    for (const style of THEME_STYLES) {
      expect(() => readFileSync(sourceOf(fonts.THEME_FONTS[style].href))).not.toThrow();
    }
  });

  it("keeps the fallback metrics next/font would compute for each file", () => {
    // The same code next/font uses (fontkit + Arial's average width).
    const nextDir = dirname(require.resolve("next/package.json"));
    const fontkit = require(join(nextDir, "dist/compiled/@next/font/dist/fontkit")) as {
      default: { default?: (buffer: Buffer) => unknown } & ((buffer: Buffer) => unknown);
    };
    const create = fontkit.default.default ?? fontkit.default;
    const { getFallbackMetricsFromFontFile } = require(
      join(nextDir, "dist/compiled/@next/font/dist/local/get-fallback-metrics-from-font-file"),
    ) as {
      getFallbackMetricsFromFontFile: (
        font: unknown,
        category: string,
      ) => Record<"ascentOverride" | "descentOverride" | "lineGapOverride" | "sizeAdjust", string>;
    };
    for (const style of THEME_STYLES) {
      const font = fonts.THEME_FONTS[style];
      const metrics = getFallbackMetricsFromFontFile(
        create(readFileSync(sourceOf(font.href))),
        "sans-serif",
      );
      expect(font.fallback).toEqual({
        ascent: metrics.ascentOverride,
        descent: metrics.descentOverride,
        lineGap: metrics.lineGapOverride,
        sizeAdjust: metrics.sizeAdjust,
      });
    }
  });

  it("writes only its own constants into the CSS", () => {
    const css = fonts.themeFontFaces("editorial");
    expect(css).toContain('font-family:"Rikuy Editorial"');
    expect(css).toContain(
      'font-family:"Rikuy Editorial Fallback";src:local("Arial"),local("Liberation Sans"),local("Arimo")',
    );
    expect(css).not.toContain("Rikuy Inmersivo");
    expect(fonts.themeFontFaces("immersive")).toContain(fonts.THEME_FONTS.immersive.href);
  });

  it("titles swap; reading text never reflows after the first paint", () => {
    const css = fonts.themeFontFaces("editorial");
    expect(css).toMatch(/font-family:"Rikuy Editorial";[^}]*font-display:swap/u);
    expect(css).toMatch(/font-family:"Rikuy Editorial Text";[^}]*font-display:optional/u);
    // One file for both families: a single download.
    expect(css.split(fonts.THEME_FONTS.editorial.href).length - 1).toBe(2);
    // Immersive reads in the system font: no text family.
    expect(fonts.themeFontFaces("immersive")).not.toContain("Text");
  });
});
