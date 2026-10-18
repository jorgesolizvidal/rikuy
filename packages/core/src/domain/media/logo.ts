import type { ImageInfo } from "./image";
import {
  checkDeclaredImage,
  checkUploadedImage,
  isAcceptedMime,
  type ImageProblem,
  type ImageRules,
} from "./rules";

/** What a municipality logo may be. SVG is excluded on purpose: it can carry scripts. */
export const LOGO_RULES = {
  mimes: ["image/png", "image/jpeg", "image/webp"],
  maxBytes: 2 * 1024 * 1024,
  minSide: 64,
  maxSide: 4096,
} as const satisfies ImageRules;

/** Derivatives produced for every logo (and copied to the public bucket on publish). */
export const LOGO_FILES = ["logo.webp", "logo.png"] as const;
export type LogoFile = (typeof LOGO_FILES)[number];

export type LogoProblem = ImageProblem;

export function isImageMime(value: unknown) {
  return isAcceptedMime(LOGO_RULES, value);
}

export function checkDeclaredLogo(mime: unknown, bytes: unknown): LogoProblem | null {
  return checkDeclaredImage(LOGO_RULES, mime, bytes);
}

export function checkUploadedLogo(
  info: ImageInfo | null,
  bytes: number,
  declaredMime: string,
): LogoProblem | null {
  return checkUploadedImage(LOGO_RULES, info, bytes, declaredMime);
}
