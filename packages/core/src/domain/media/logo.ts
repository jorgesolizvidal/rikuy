import type { ImageInfo, ImageMime } from "./image";

/** What a municipality logo may be. SVG is excluded on purpose: it can carry scripts. */
export const LOGO_RULES = {
  mimes: ["image/png", "image/jpeg", "image/webp"] as readonly ImageMime[],
  maxBytes: 2 * 1024 * 1024,
  minSide: 64,
  maxSide: 4096,
} as const;

/** Derivatives produced for every logo (and copied to the public bucket on publish). */
export const LOGO_FILES = ["logo.webp", "logo.png"] as const;
export type LogoFile = (typeof LOGO_FILES)[number];

export type LogoProblem =
  "unsupported_type" | "too_heavy" | "type_mismatch" | "too_small" | "too_large" | "unreadable";

export function isImageMime(value: unknown): value is ImageMime {
  return typeof value === "string" && (LOGO_RULES.mimes as readonly string[]).includes(value);
}

/** Checks what the browser declares before anything is uploaded. */
export function checkDeclaredLogo(mime: unknown, bytes: unknown): LogoProblem | null {
  if (!isImageMime(mime)) return "unsupported_type";
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 1) return "unreadable";
  if (bytes > LOGO_RULES.maxBytes) return "too_heavy";
  return null;
}

/** Checks the uploaded bytes against the rules and the declared type. */
export function checkUploadedLogo(
  info: ImageInfo | null,
  bytes: number,
  declaredMime: string,
): LogoProblem | null {
  if (info === null) return "unreadable";
  if (!isImageMime(info.mime)) return "unsupported_type";
  if (info.mime !== declaredMime) return "type_mismatch";
  if (bytes > LOGO_RULES.maxBytes) return "too_heavy";
  if (Math.min(info.width, info.height) < LOGO_RULES.minSide) return "too_small";
  if (Math.max(info.width, info.height) > LOGO_RULES.maxSide) return "too_large";
  return null;
}
