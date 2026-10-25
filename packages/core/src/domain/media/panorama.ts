import type { ImageRules } from "./rules";

/**
 * Panoramas (ADR-020): equirectangular photos (2:1) delivered according to their width.
 *
 * - ≤ 4096 px: a blurred preview + one high-quality WebP.
 * - > 4096 px: the same, plus equirectangular tiles of 512 px in several levels (mobile GPUs
 *   cap textures at 4096 px); the single WebP stays as the fallback.
 */
export const PANORAMA_RULES: ImageRules = {
  mimes: ["image/jpeg", "image/png", "image/webp"],
  maxBytes: 50 * 1024 * 1024,
  /** Height of at least 1024 px (2048 × 1024): smaller looks blurry in a 360° viewer. */
  minSide: 1024,
  maxSide: 16_384,
};

export const PANORAMA_IMAGE_MAX_WIDTH = 4096;
export const PANORAMA_TILE_SIZE = 512;
export const PANORAMA_PREVIEW_WIDTH = 1024;
export const PANORAMA_PREVIEW_MAX_BYTES = 40_000;
/** Accepted deviation from 2:1 (some cameras crop a few pixels). */
export const PANORAMA_ASPECT_TOLERANCE = 0.01;

export type PanoramaProblem =
  | "unsupported_type"
  | "too_heavy"
  | "type_mismatch"
  | "too_small"
  | "too_large"
  | "unreadable"
  | "not_equirectangular";

export function isEquirectangular(width: number, height: number): boolean {
  return height > 0 && Math.abs(width / height - 2) <= 2 * PANORAMA_ASPECT_TOLERANCE;
}

export interface PanoramaLevelPlan {
  readonly width: number;
  readonly height: number;
  readonly cols: number;
  readonly rows: number;
}

export interface PanoramaPlan {
  /** Size of the single WebP (never enlarged, at most 4096 px wide). */
  readonly image: { readonly width: number; readonly height: number };
  readonly preview: { readonly width: number; readonly height: number };
  /** Null when the source is not wider than 4096 px. */
  readonly levels: readonly PanoramaLevelPlan[] | null;
}

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/** What to render for a source of this width (pure; same input, same plan). */
export function planPanorama(sourceWidth: number): PanoramaPlan {
  const imageWidth = even(Math.min(sourceWidth, PANORAMA_IMAGE_MAX_WIDTH));
  const previewWidth = Math.min(PANORAMA_PREVIEW_WIDTH, imageWidth);
  const image = { width: imageWidth, height: imageWidth / 2 };
  const preview = { width: previewWidth, height: Math.round(previewWidth / 2) };
  if (sourceWidth <= PANORAMA_IMAGE_MAX_WIDTH) return { image, preview, levels: null };

  // Tiles of 512 px need a width multiple of 1024 (the height is half of it). Levels double
  // from 2048 up to the source width, never enlarging it.
  const top = Math.floor(sourceWidth / 1024) * 1024;
  const widths: number[] = [];
  for (let width = 2048; width < top; width *= 2) widths.push(width);
  widths.push(top);
  const levels = widths.map((width) => ({
    width,
    height: width / 2,
    cols: width / PANORAMA_TILE_SIZE,
    rows: width / 2 / PANORAMA_TILE_SIZE,
  }));
  return { image, preview, levels };
}

/** Number of tile files a plan produces (for limits and progress). */
export function panoramaTileCount(plan: PanoramaPlan): number {
  return (plan.levels ?? []).reduce((sum, level) => sum + level.cols * level.rows, 0);
}
