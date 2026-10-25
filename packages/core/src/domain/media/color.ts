import type { ColorCheck } from "../../contracts/model";

/**
 * Color math for the model pipeline's checks (ADR-026): how different two colors look,
 * as ΔE in CIELAB (D65). A ΔE of about 2.3 is the smallest difference people notice.
 */

/** sRGB-encoded channel (0–1) → linear light. */
export function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** Linear light (0–1) → sRGB-encoded channel (glTF vertex colors and factors are linear). */
export function linearToSrgb(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

export type Lab = readonly [number, number, number];

/** sRGB-encoded color (0–1 per channel) → CIELAB. */
export function srgbToLab(r: number, g: number, b: number): Lab {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const y = f(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIE76 color difference. */
export function deltaE(a: Lab, b: Lab): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Mean and 95th percentile of a set of differences, rounded to hundredths. */
export function summarizeDifferences(values: readonly number[]): ColorCheck {
  if (values.length === 0) return { mean: 0, p95: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  return { mean: Math.round(mean * 100) / 100, p95: Math.round(p95 * 100) / 100 };
}

/**
 * Per-pixel ΔE between two RGBA (or RGB) rasters of the same size, sRGB-encoded 0–255.
 * Pixels transparent in both are skipped (their color is not seen).
 */
export function rasterDeltaE(a: Uint8Array, b: Uint8Array, channels: 3 | 4): ColorCheck {
  const differences: number[] = [];
  for (let i = 0; i + channels <= a.length && i + channels <= b.length; i += channels) {
    if (channels === 4 && (a[i + 3] ?? 0) === 0 && (b[i + 3] ?? 0) === 0) continue;
    differences.push(
      deltaE(
        srgbToLab((a[i] ?? 0) / 255, (a[i + 1] ?? 0) / 255, (a[i + 2] ?? 0) / 255),
        srgbToLab((b[i] ?? 0) / 255, (b[i + 1] ?? 0) / 255, (b[i + 2] ?? 0) / 255),
      ),
    );
  }
  return summarizeDifferences(differences);
}
