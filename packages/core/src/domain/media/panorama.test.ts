import { describe, expect, it } from "vitest";

import { panoramaManifestSchema } from "../../contracts/panorama";
import { requestPanoramaUpload, submitPanorama } from "../../application/media/panoramas";
import { isEquirectangular, panoramaTileCount, planPanorama } from "./panorama";

describe("panorama delivery by resolution (ADR-020)", () => {
  it("delivers one image up to 4096 px, without tiles", () => {
    expect(planPanorama(2880)).toEqual({
      image: { width: 2880, height: 1440 },
      preview: { width: 1024, height: 512 },
      levels: null,
    });
    expect(planPanorama(4096).levels).toBeNull();
  });

  it("adds tiles above 4096 px, doubling from 2048 to the source width without enlarging", () => {
    const plan = planPanorama(8192);
    expect(plan.image).toEqual({ width: 4096, height: 2048 });
    expect(plan.levels).toEqual([
      { width: 2048, height: 1024, cols: 4, rows: 2 },
      { width: 4096, height: 2048, cols: 8, rows: 4 },
      { width: 8192, height: 4096, cols: 16, rows: 8 },
    ]);
    expect(panoramaTileCount(plan)).toBe(168);
  });

  it("rounds an odd source width down to whole tiles", () => {
    const plan = planPanorama(6000);
    expect(plan.levels?.map((level) => level.width)).toEqual([2048, 4096, 5120]);
    expect(plan.levels?.at(-1)).toMatchObject({ cols: 10, rows: 5 });
    expect(planPanorama(16_384).levels?.at(-1)).toMatchObject({
      width: 16_384,
      cols: 32,
      rows: 16,
    });
  });

  it("accepts only 2:1 images, with a small tolerance", () => {
    expect(isEquirectangular(8192, 4096)).toBe(true);
    expect(isEquirectangular(6000, 2990)).toBe(true);
    expect(isEquirectangular(4000, 3000)).toBe(false);
    expect(isEquirectangular(4096, 0)).toBe(false);
  });
});

describe("panorama manifest", () => {
  const manifest = {
    version: 1,
    projection: "equirectangular",
    source: {
      width: 8192,
      height: 4096,
      bytes: 9_000_000,
      mime: "image/jpeg",
      sha256: "a".repeat(64),
    },
    preview: { file: "preview.webp", width: 1024, height: 512, bytes: 18_000 },
    image: { file: "image.webp", width: 4096, height: 2048, bytes: 1_400_000 },
    tiles: {
      tileSize: 512,
      format: "webp",
      levels: [{ width: 2048, height: 1024, cols: 4, rows: 2, dir: "tiles/0" }],
    },
  };

  it("validates what the pipeline writes", () => {
    expect(panoramaManifestSchema.safeParse(manifest).success).toBe(true);
    expect(panoramaManifestSchema.safeParse({ ...manifest, tiles: null }).success).toBe(true);
  });

  it("refuses paths that escape the version folder and images above 4096 px", () => {
    expect(
      panoramaManifestSchema.safeParse({
        ...manifest,
        preview: { ...manifest.preview, file: "../x.webp" },
      }).success,
    ).toBe(false);
    expect(
      panoramaManifestSchema.safeParse({ ...manifest, image: { ...manifest.image, width: 8192 } })
        .success,
    ).toBe(false);
  });
});

describe("panorama uploads", () => {
  const editor = {
    tenantId: "t",
    slug: "t",
    displayName: "T",
    role: "editor" as const,
    tenantStatus: "active" as const,
  };
  const media = {
    createImageUpload: async () => ({
      status: "created" as const,
      upload: { assetId: "a", versionId: "v", version: 1, originalPath: "t/a/1/original" },
    }),
    signedUploadUrl: async () => "https://upload.example.test/x",
    findVersion: async () => null,
    signedPreviewUrl: async () => null,
    signedPreviewUrls: async () => new Map(),
  };

  it("lets editors upload up to 50 MB of JPEG, PNG or WebP", async () => {
    expect(
      await requestPanoramaUpload(editor, { mime: "image/jpeg", bytes: 40_000_000 }, media),
    ).toMatchObject({
      status: "upload",
      versionId: "v",
    });
    expect(
      await requestPanoramaUpload(editor, { mime: "image/jpeg", bytes: 60_000_000 }, media),
    ).toEqual({
      status: "invalid",
      problem: "too_heavy",
    });
    expect(
      await requestPanoramaUpload(editor, { mime: "image/svg+xml", bytes: 10 }, media),
    ).toEqual({
      status: "invalid",
      problem: "unsupported_type",
    });
  });

  it("keeps analysts out and validates the version id", async () => {
    const analyst = { ...editor, role: "analyst" as const };
    expect(await requestPanoramaUpload(analyst, { mime: "image/jpeg", bytes: 10 }, media)).toEqual({
      status: "forbidden",
    });
    const panoramas = { list: async () => [], submit: async () => "processing" as const };
    expect(await submitPanorama(analyst, "5eed9000-0000-4000-8000-000000000001", panoramas)).toBe(
      "forbidden",
    );
    expect(await submitPanorama(editor, "../etc", panoramas)).toBe("not_found");
    expect(await submitPanorama(editor, "5eed9000-0000-4000-8000-000000000001", panoramas)).toBe(
      "processing",
    );
  });
});
