/**
 * Color math for tenant themes (WCAG 2.x contrast).
 *
 * Colors are stored as lowercase `#rrggbb`. Anything else is rejected before it can reach
 * a stylesheet, so a tenant can never inject CSS through a color value.
 */

export const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

export function isHexColor(value: string): boolean {
  return HEX_COLOR_PATTERN.test(value);
}

function channel(hex: string, offset: number): number {
  const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance as defined by WCAG 2.x (0 = black, 1 = white). */
export function relativeLuminance(hex: string): number {
  if (!isHexColor(hex)) throw new Error(`Not a #rrggbb color: ${hex}`);
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

/** Contrast ratio between two colors, from 1 (none) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

/** Of the given candidates, the one with the highest contrast against `background`. */
export function mostReadable(
  background: string,
  candidates: readonly [string, ...string[]],
): string {
  return candidates.reduce((best, candidate) =>
    contrastRatio(candidate, background) > contrastRatio(best, background) ? candidate : best,
  );
}
