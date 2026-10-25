import { z } from "zod";

/**
 * Manifest of a processed panorama (ADR-017, ADR-020): what was rendered from one image
 * version and where. Stored with the version; viewers read it, hotspots never depend on it.
 * Every file is relative to the version's `panorama/` folder.
 */
export const PANORAMA_MANIFEST_VERSION = 1;

const file = z
  .string()
  .regex(/^[a-z0-9_./-]{1,120}$/u)
  .refine((value) => !value.includes(".."), "no parent paths");
const pixels = z.number().int().min(1).max(16_384);

export const panoramaLevelSchema = z
  .object({
    width: pixels,
    height: pixels,
    cols: z.number().int().min(1).max(64),
    rows: z.number().int().min(1).max(32),
    /** Folder of the level's tiles: `{dir}/{col}_{row}.webp`. */
    dir: file,
  })
  .strict();

export const panoramaManifestSchema = z
  .object({
    version: z.literal(PANORAMA_MANIFEST_VERSION),
    projection: z.literal("equirectangular"),
    source: z
      .object({
        width: pixels,
        height: pixels,
        bytes: z.number().int().min(1),
        mime: z.enum(["image/jpeg", "image/png", "image/webp"]),
        sha256: z.string().regex(/^[0-9a-f]{64}$/u),
      })
      .strict(),
    /** Blurred, shown at once while the rest loads (≤ 40 KB). */
    preview: z.object({ file, width: pixels, height: pixels, bytes: z.number().int() }).strict(),
    /** One WebP of at most 4096 px: the delivery up to 4096 px, the fallback above. */
    image: z
      .object({
        file,
        width: z.number().int().min(1).max(4096),
        height: pixels,
        bytes: z.number().int(),
      })
      .strict(),
    /** Equirectangular tiles, only for sources wider than 4096 px. */
    tiles: z
      .object({
        tileSize: z.literal(512),
        format: z.literal("webp"),
        levels: z.array(panoramaLevelSchema).min(1).max(6),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type PanoramaManifest = z.infer<typeof panoramaManifestSchema>;
export type PanoramaLevel = z.infer<typeof panoramaLevelSchema>;
