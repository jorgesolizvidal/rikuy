import { z } from "zod";

/**
 * Manifest of a processed 3D model (ADR-026): what was made from one GLB version and the
 * color check behind it. Stored with the version; the viewer reads it, hotspots never
 * depend on it. Files are relative to the version's `model/` folder.
 */
export const MODEL_MANIFEST_VERSION = 1;

/** Names come from the author's file: short, and never with parent paths. */
const label = z
  .string()
  .min(1)
  .max(80)
  .refine((value) => !value.includes(".."), "no parent paths");
const count = z.number().int().min(0);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
/** Color difference (ΔE, CIELAB) for color textures, degrees for normal maps, 0–255 for data. */
const check = z.object({ mean: z.number().min(0), p95: z.number().min(0) }).strict();

export const MODEL_TEXTURE_USAGES = ["color", "normal", "data"] as const;
export type ModelTextureUsage = (typeof MODEL_TEXTURE_USAGES)[number];
export const MODEL_TEXTURE_ENCODINGS = ["etc1s", "uastc", "original"] as const;
export type ModelTextureEncoding = (typeof MODEL_TEXTURE_ENCODINGS)[number];

export const modelTextureSchema = z
  .object({
    name: label,
    usage: z.enum(MODEL_TEXTURE_USAGES),
    width: z.number().int().min(1).max(16_384),
    height: z.number().int().min(1).max(16_384),
    /** "original": kept as uploaded (KTX2 would have changed its colors, or it already was). */
    encoding: z.enum(MODEL_TEXTURE_ENCODINGS),
    bytes: count,
    check: check.nullable(),
  })
  .strict();

/** A material that uses, as its color, a texture another material uses as data. */
export const colorSuspectSchema = z.object({ material: label, texture: label }).strict();

export const modelPosterSchema = z
  .object({
    file: z.literal("poster.webp"),
    width: z.number().int().min(64).max(2048),
    height: z.number().int().min(64).max(2048),
    bytes: z.number().int().min(1).max(1_048_576),
  })
  .strict();

export const modelManifestSchema = z
  .object({
    version: z.literal(MODEL_MANIFEST_VERSION),
    format: z.literal("glb"),
    source: z
      .object({
        bytes: z.number().int().min(1),
        sha256,
        triangles: count,
        vertices: count,
        materials: count,
        textures: count,
        generator: z.string().max(120).nullable(),
        extensions: z.array(z.string().max(64)).max(32),
      })
      .strict(),
    model: z
      .object({
        file: z.literal("model.glb"),
        bytes: z.number().int().min(1).max(15_728_640),
        triangles: count,
        geometry: z.literal("meshopt"),
        textures: z.array(modelTextureSchema).max(64),
      })
      .strict(),
    colors: z
      .object({
        /** Every primitive keeps its material's colors, factors and textures. */
        materials: z.literal("unchanged"),
        /** Vertex colors (COLOR_0) after quantization, as ΔE; null when the model has none. */
        vertexColors: check.nullable(),
        suspects: z.array(colorSuspectSchema).max(32),
      })
      .strict(),
    /** light: ≤ 5 MB · heavy: 5–15 MB (works, but slow on phones). */
    weight: z.enum(["light", "heavy"]),
    /** Captured by the panel with the portal's viewer (no GPU on the server). */
    poster: modelPosterSchema.nullable(),
  })
  .strict();

export type ModelManifest = z.infer<typeof modelManifestSchema>;
export type ModelTexture = z.infer<typeof modelTextureSchema>;
export type ModelPoster = z.infer<typeof modelPosterSchema>;
export type ColorSuspect = z.infer<typeof colorSuspectSchema>;
export type ColorCheck = z.infer<typeof check>;
