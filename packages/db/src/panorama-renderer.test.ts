import { planPanorama, PANORAMA_PREVIEW_MAX_BYTES } from "@rikuy/core";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { createSharpPanoramaRenderer } from "./panorama-renderer";

/** A photo-like 2:1 source (smooth gradient + a little noise), with GPS in its EXIF. */
async function panorama(width: number): Promise<Uint8Array> {
  const height = width / 2;
  const base = await sharp({
    create: { width, height, channels: 3, background: { r: 90, g: 140, b: 200 } },
  })
    .composite([
      {
        input: await sharp({
          create: {
            width,
            height,
            channels: 3,
            background: { r: 0, g: 0, b: 0 },
            noise: { type: "gaussian", mean: 128, sigma: 12 },
          },
        })
          .png()
          .toBuffer(),
        blend: "overlay",
      },
    ])
    .jpeg({ quality: 85 })
    .withExif({ IFD3: { GPSLatitudeRef: "S", GPSLatitude: "17/1 23/1 0/1" } })
    .toBuffer();
  return new Uint8Array(base);
}

describe("sharp panorama renderer", () => {
  const renderer = createSharpPanoramaRenderer();

  it("renders a blurred preview within 40 KB and a WebP without metadata", async () => {
    const source = await panorama(4096);
    const plan = planPanorama(4096);
    const preview = await renderer.preview(source, plan);
    const image = await renderer.image(source, plan);

    expect(preview).toMatchObject({
      width: 1024,
      height: 512,
      file: { contentType: "image/webp" },
    });
    expect(preview.file.bytes.byteLength).toBeLessThanOrEqual(PANORAMA_PREVIEW_MAX_BYTES);
    const info = await sharp(image.file.bytes).metadata();
    expect(info).toMatchObject({ format: "webp", width: 4096, height: 2048 });
    expect(info.exif).toBeUndefined();
  }, 30_000);

  it("cuts 512 px tiles for each level", async () => {
    const source = await panorama(6144);
    const level = planPanorama(6144).levels?.at(-1);
    if (!level) throw new Error("expected tiles for 6144 px");
    expect(level).toMatchObject({ width: 6144, cols: 12, rows: 6 });
    const tiles = await renderer.tiles(source, level);
    expect(tiles).toHaveLength(72);
    expect(tiles[0]?.name).toBe("0_0.webp");
    expect(tiles.at(-1)?.name).toBe("11_5.webp");
    expect(await sharp(tiles[13]?.bytes).metadata()).toMatchObject({ width: 512, height: 512 });
  }, 60_000);

  it("refuses a corrupt file", async () => {
    const source = await panorama(2048);
    const truncated = source.slice(0, Math.floor(source.byteLength / 2));
    await expect(renderer.image(truncated, planPanorama(2048))).rejects.toThrow();
  }, 30_000);
});
