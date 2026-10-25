import type { ColorCheck, ModelTextureUsage } from "../../contracts/model";

/**
 * 3D models (ADR-026): a self-contained GLB, optimized with Meshopt geometry and KTX2
 * textures, delivered only when the visitor opens the hotspot (P4).
 */
export const MODEL_MIME = "model/gltf-binary";

export const MODEL_LIMITS = {
  /** Upload (the original bucket's limit). */
  maxBytes: 50 * 1024 * 1024,
  /** Past this the phone viewer struggles even after optimization. */
  maxTriangles: 2_000_000,
  maxTextures: 64,
  /** Optimized textures are at most this wide (the KTX2 encoder's limit is ~12 Mpix). */
  textureMaxSide: 2048,
  /** Performance budget: up to 5 MB fine, 5–15 MB works but heavy, above rejected. */
  lightBytes: 5 * 1024 * 1024,
  maxOptimizedBytes: 15 * 1024 * 1024,
} as const;

/**
 * How far a compressed texture may drift before the pipeline tries a better encoding (and,
 * failing that, keeps the original). Color: ΔE in CIELAB (≈ 2.3 is just noticeable).
 * Normal maps: degrees. Data (metal, roughness, occlusion): 0–255 per channel.
 */
export const TEXTURE_TOLERANCE: Readonly<Record<ModelTextureUsage, ColorCheck>> = {
  color: { mean: 2, p95: 4 },
  normal: { mean: 3, p95: 8 },
  data: { mean: 4, p95: 12 },
};

/** Vertex colors after quantization (ΔE). */
export const VERTEX_COLOR_TOLERANCE: ColorCheck = { mean: 1, p95: 2 };

export type ModelProblem =
  | "unsupported_type"
  | "too_heavy"
  | "not_glb"
  | "invalid_model"
  | "external_files"
  | "unsupported_extension"
  | "too_complex"
  | "too_heavy_optimized"
  | "colors_changed"
  | "unreadable";

export const MODEL_PROBLEMS: readonly ModelProblem[] = [
  "unsupported_type",
  "too_heavy",
  "not_glb",
  "invalid_model",
  "external_files",
  "unsupported_extension",
  "too_complex",
  "too_heavy_optimized",
  "colors_changed",
  "unreadable",
];

/** What the browser declares before uploading (it sends model/gltf-binary for .glb). */
export function checkDeclaredModel(mime: unknown, bytes: unknown): ModelProblem | null {
  if (mime !== MODEL_MIME) return "unsupported_type";
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 1) return "unreadable";
  if (bytes > MODEL_LIMITS.maxBytes) return "too_heavy";
  return null;
}

/** A binary glTF 2.0 header whose declared length matches the file. */
export function isGlb(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 20) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return (
    view.getUint32(0, true) === 0x46546c67 && // "glTF"
    view.getUint32(4, true) === 2 &&
    view.getUint32(8, true) === bytes.byteLength
  );
}

export function withinTolerance(check: ColorCheck, tolerance: ColorCheck): boolean {
  return check.mean <= tolerance.mean && check.p95 <= tolerance.p95;
}

export function modelWeight(bytes: number): "light" | "heavy" | "too_heavy" {
  if (bytes <= MODEL_LIMITS.lightBytes) return "light";
  return bytes <= MODEL_LIMITS.maxOptimizedBytes ? "heavy" : "too_heavy";
}

/** Names from the author's file, safe for the manifest (short, no parent paths). */
export function manifestLabel(value: string | null | undefined, fallback: string): string {
  const clean = (value ?? "")
    .replace(/\.{2,}/gu, ".")
    .trim()
    .slice(0, 80);
  return clean === "" ? fallback : clean;
}
