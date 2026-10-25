import {
  PANORAMA_PREVIEW_MAX_BYTES,
  PANORAMA_TILE_SIZE,
  type DerivedFile,
  type PanoramaRenderer,
} from "@rikuy/core";
import sharp from "sharp";

/**
 * Panorama renditions with sharp/libvips (ADR-020). Metadata (EXIF, GPS) is never copied.
 * failOn rejects truncated or corrupt files; limitInputPixels caps decompression bombs at
 * the largest accepted panorama (16384 × 8192).
 */
const MAX_PIXELS = 16_384 * 8192;
/** Tiles encoded at the same time (libvips also uses its own threads). */
const TILE_CONCURRENCY = 16;

export function createSharpPanoramaRenderer(): PanoramaRenderer {
  const source = (original: Uint8Array) =>
    sharp(original, { failOn: "error", limitInputPixels: MAX_PIXELS });

  return {
    async preview(original, plan) {
      const { width, height } = plan.preview;
      // Blurred and small: shown at once; quality goes down until it fits in 40 KB.
      let bytes: Buffer | null = null;
      for (const quality of [60, 50, 40, 30, 20]) {
        bytes = await source(original)
          .resize(width, height, { fit: "fill" })
          .blur(2)
          .webp({ quality })
          .toBuffer();
        if (bytes.byteLength <= PANORAMA_PREVIEW_MAX_BYTES) break;
      }
      return { file: webp("preview.webp", bytes as Buffer), width, height };
    },

    async image(original, plan) {
      const { width, height } = plan.image;
      const bytes = await source(original)
        .resize(width, height, { fit: "fill" })
        .webp({ quality: 86, effort: 4 })
        .toBuffer();
      return { file: webp("image.webp", bytes), width, height };
    },

    async tiles(original, level) {
      // Resize once to raw pixels, then cut and encode the tiles from memory.
      const raw = await source(original)
        .resize(level.width, level.height, { fit: "fill" })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const cuts: { col: number; row: number }[] = [];
      for (let row = 0; row < level.rows; row += 1) {
        for (let col = 0; col < level.cols; col += 1) cuts.push({ col, row });
      }
      const files: DerivedFile[] = [];
      for (let start = 0; start < cuts.length; start += TILE_CONCURRENCY) {
        const batch = cuts.slice(start, start + TILE_CONCURRENCY);
        files.push(
          ...(await Promise.all(
            batch.map(async ({ col, row }) =>
              webp(
                `${col}_${row}.webp`,
                await sharp(raw.data, { raw: raw.info })
                  .extract({
                    left: col * PANORAMA_TILE_SIZE,
                    top: row * PANORAMA_TILE_SIZE,
                    width: PANORAMA_TILE_SIZE,
                    height: PANORAMA_TILE_SIZE,
                  })
                  .webp({ quality: 82 })
                  .toBuffer(),
              ),
            ),
          )),
        );
      }
      return files;
    },
  };
}

function webp(name: string, bytes: Buffer): DerivedFile {
  return { name, contentType: "image/webp", bytes: new Uint8Array(bytes) };
}
