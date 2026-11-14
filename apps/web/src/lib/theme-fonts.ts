import type { ThemeStyle } from "@rikuy/core";

/**
 * The fonts of each portal theme (ADR-061). The style brings them: a municipality never
 * picks a font. Each portal preloads only its theme's file (one woff2, latin subset), served
 * from public/vendor/fonts/<package>/<version>/ (scripts/vendor-fonts.mjs), so the address is
 * stable and cached for a year.
 *
 * The fallback face resizes the local Arial (or its metric twins Liberation Sans and Arimo) to
 * the web font's metrics (the values next/font computes, checked in theme-fonts.test.ts), so
 * the text barely moves when the font arrives.
 *
 * A theme whose body text also uses its font gets a second family for reading, with
 * `font-display: optional`: if the file is not there for the first paint, paragraphs stay in
 * the fallback for that visit instead of reflowing the page under the visitor (on /mapa the
 * reflow moved the whole map, CLS 0.146). Titles keep `swap`. Same file, one download.
 */

export interface ThemeFont {
  /** CSS family name of the web font (titles: `swap`). */
  readonly family: string;
  readonly href: string;
  readonly fallback: {
    readonly ascent: string;
    readonly descent: string;
    readonly lineGap: string;
    readonly sizeAdjust: string;
  };
  /** Whether body text also uses it (otherwise only titles; body keeps the system font). */
  readonly body: boolean;
}

/** Latin subset of the fontsource files (Spanish and English). */
const LATIN =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";

const vendor = (name: string, version: string | undefined, file: string) =>
  `/vendor/fonts/${name}/${version ?? "0.0.0"}/${file}`;

export const THEME_FONTS: Readonly<Record<ThemeStyle, ThemeFont>> = {
  editorial: {
    family: "Rikuy Editorial",
    href: vendor(
      "plus-jakarta-sans",
      process.env.NEXT_PUBLIC_JAKARTA_VERSION,
      "plus-jakarta-sans-latin-wght-normal.woff2",
    ),
    fallback: { ascent: "98.16%", descent: "20.99%", lineGap: "0.00%", sizeAdjust: "105.75%" },
    body: true,
  },
  immersive: {
    family: "Rikuy Inmersivo",
    href: vendor(
      "bricolage-grotesque",
      process.env.NEXT_PUBLIC_BRICOLAGE_VERSION,
      "bricolage-grotesque-latin-wght-normal.woff2",
    ),
    fallback: { ascent: "82.39%", descent: "23.92%", lineGap: "0.00%", sizeAdjust: "112.88%" },
    body: false,
  },
};

/**
 * The @font-face rules of one theme: the web font and its resized fallback. Only constants
 * of this module go into the CSS, never tenant data.
 */
export function themeFontFaces(style: ThemeStyle): string {
  const font = THEME_FONTS[style];
  const { ascent, descent, lineGap, sizeAdjust } = font.fallback;
  const face = (family: string, display: "swap" | "optional") =>
    `@font-face{font-family:"${family}";src:url("${font.href}") format("woff2");font-weight:200 800;font-style:normal;font-display:${display};unicode-range:${LATIN}}`;
  return [
    face(font.family, "swap"),
    ...(font.body ? [face(textFamily(font), "optional")] : []),
    `@font-face{font-family:"${font.family} Fallback";src:local("Arial"),local("Liberation Sans"),local("Arimo");ascent-override:${ascent};descent-override:${descent};line-gap-override:${lineGap};size-adjust:${sizeAdjust}}`,
  ].join("");
}

/** The family body text uses, when the theme's font is also for reading. */
export function textFamily(font: ThemeFont): string {
  return `${font.family} Text`;
}
