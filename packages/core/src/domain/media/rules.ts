import type { ImageInfo, ImageMime } from "./image";

/** Limits an uploaded image must respect (checked on the real bytes, not the name). */
export interface ImageRules {
  readonly mimes: readonly ImageMime[];
  readonly maxBytes: number;
  readonly minSide: number;
  readonly maxSide: number;
}

export type ImageProblem =
  "unsupported_type" | "too_heavy" | "type_mismatch" | "too_small" | "too_large" | "unreadable";

const ACCEPTED: readonly ImageMime[] = ["image/png", "image/jpeg", "image/webp"];

/** Photos of destinations: up to the originals bucket limit; derivatives are responsive. */
export const CONTENT_IMAGE_RULES: ImageRules = {
  mimes: ACCEPTED,
  maxBytes: 10 * 1024 * 1024,
  minSide: 320,
  maxSide: 8192,
};

/** Widths of the WebP derivatives of a content image (never enlarged). */
export const CONTENT_IMAGE_WIDTHS = [480, 960, 1600] as const;
export const CONTENT_IMAGE_FILES = ["w480.webp", "w960.webp", "w1600.webp"] as const;
export type ContentImageFile = (typeof CONTENT_IMAGE_FILES)[number];

export function isAcceptedMime(rules: ImageRules, value: unknown): value is ImageMime {
  return typeof value === "string" && (rules.mimes as readonly string[]).includes(value);
}

/** Checks what the browser declares before anything is uploaded. */
export function checkDeclaredImage(
  rules: ImageRules,
  mime: unknown,
  bytes: unknown,
): ImageProblem | null {
  if (!isAcceptedMime(rules, mime)) return "unsupported_type";
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 1) return "unreadable";
  if (bytes > rules.maxBytes) return "too_heavy";
  return null;
}

/** Checks the uploaded bytes against the rules and the declared type. */
export function checkUploadedImage(
  rules: ImageRules,
  info: ImageInfo | null,
  bytes: number,
  declaredMime: string,
): ImageProblem | null {
  if (info === null) return "unreadable";
  if (!isAcceptedMime(rules, info.mime)) return "unsupported_type";
  if (info.mime !== declaredMime) return "type_mismatch";
  if (bytes > rules.maxBytes) return "too_heavy";
  if (Math.min(info.width, info.height) < rules.minSide) return "too_small";
  if (Math.max(info.width, info.height) > rules.maxSide) return "too_large";
  return null;
}
