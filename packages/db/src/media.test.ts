import { inspectImage } from "@rikuy/core";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { createMediaRepository, createSharpImageProcessor, publicMediaUrl } from "./media";
import { createSessionClient } from "./session-client";

const BASE = "http://127.0.0.1:54321";
const TENANT = "5eed1000-0000-4000-8000-000000000001";
const ASSET = "5eed4000-0000-4000-8000-000000000001";

function session(route: (url: URL, init: RequestInit) => Response) {
  const calls: { url: URL; method: string; body: unknown }[] = [];
  const client = createSessionClient({
    url: BASE,
    publishableKey: "sb_publishable_test",
    secureCookies: false,
    cookies: { getAll: () => [], setAll: () => undefined },
    fetch: async (input, init = {}) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      calls.push({
        url,
        method: init.method ?? "GET",
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      return route(url, init);
    },
  });
  return { repo: createMediaRepository(client), calls };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

describe("media repository", () => {
  it("starts an upload with the declared type and size", async () => {
    const { repo, calls } = session(() =>
      json([
        {
          asset_id: ASSET,
          version_id: ASSET,
          version: 1,
          original_path: `${TENANT}/${ASSET}/1/original`,
        },
      ]),
    );
    expect(await repo.createImageUpload(TENANT, "logo", "image/png", 2048)).toMatchObject({
      status: "created",
      upload: { originalPath: `${TENANT}/${ASSET}/1/original` },
    });
    expect(calls[0]?.url.pathname).toBe("/rest/v1/rpc/create_image_upload");
    expect(calls[0]?.body).toEqual({
      p_tenant_id: TENANT,
      p_purpose: "logo",
      p_mime: "image/png",
      p_bytes: 2048,
    });
  });

  it.each([
    ["42501", 403, "forbidden"],
    ["23514", 400, "invalid"],
    ["PT429", 429, "rate_limited"],
  ])("maps %s to %s", async (code, status, outcome) => {
    const { repo } = session(() => json({ code, message: "x", details: null, hint: null }, status));
    expect(await repo.createImageUpload(TENANT, "logo", "image/png", 1)).toEqual({
      status: outcome,
    });
  });

  it("signs uploads for the originals bucket only", async () => {
    const { repo, calls } = session(() =>
      json({ url: `/object/upload/sign/media-originals/${TENANT}/x?token=abc` }),
    );
    const url = await repo.signedUploadUrl(`${TENANT}/x`);
    expect(url).toContain("token=abc");
    expect(calls[0]?.url.pathname).toBe(
      `/storage/v1/object/upload/sign/media-originals/${TENANT}/x`,
    );
  });

  it("builds immutable public URLs for published derivatives", () => {
    expect(publicMediaUrl(`${BASE}/`, `${TENANT}/${ASSET}/1/logo.webp`)).toBe(
      `${BASE}/storage/v1/object/public/media-public/${TENANT}/${ASSET}/1/logo.webp`,
    );
  });
});

describe("sharp image processor", () => {
  it("produces 512 px WebP and PNG derivatives without metadata", async () => {
    const original = await sharp({
      create: {
        width: 1600,
        height: 800,
        channels: 4,
        background: { r: 30, g: 110, b: 70, alpha: 1 },
      },
    })
      .withExif({ IFD0: { Copyright: "secreto", ImageDescription: "GPS 17.4S 66.1W" } })
      .jpeg()
      .toBuffer();
    expect((await sharp(original).metadata()).exif).toBeDefined();

    const files = await createSharpImageProcessor().logoDerivatives(new Uint8Array(original));
    expect(files.map((f) => [f.name, f.contentType])).toEqual([
      ["logo.webp", "image/webp"],
      ["logo.png", "image/png"],
    ]);
    for (const file of files) {
      expect(inspectImage(file.bytes)).toMatchObject({ width: 512, height: 256 });
      expect((await sharp(file.bytes).metadata()).exif).toBeUndefined();
    }
  });

  it("never enlarges small logos", async () => {
    const small = await sharp({
      create: { width: 120, height: 80, channels: 3, background: "#123456" },
    })
      .png()
      .toBuffer();
    const [webp] = await createSharpImageProcessor().logoDerivatives(new Uint8Array(small));
    expect(inspectImage(webp?.bytes ?? new Uint8Array())).toMatchObject({ width: 120, height: 80 });
  });

  it("refuses corrupt or truncated images", async () => {
    const png = await sharp({
      create: { width: 200, height: 200, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer();
    await expect(
      createSharpImageProcessor().logoDerivatives(new Uint8Array(png.subarray(0, 60))),
    ).rejects.toThrow();
  });

  it("produces 480/960/1600 px WebP photos without metadata, never enlarged", async () => {
    const photo = await sharp({
      create: { width: 2400, height: 1600, channels: 3, background: "#7a8f3c" },
    })
      .withExif({ IFD0: { Copyright: "fotógrafo", ImageDescription: "GPS 17.4S 66.1W" } })
      .jpeg()
      .toBuffer();
    const files = await createSharpImageProcessor().contentDerivatives(new Uint8Array(photo));
    expect(files.map((file) => file.name)).toEqual(["w480.webp", "w960.webp", "w1600.webp"]);
    for (const [file, width] of files.map((f, i) => [f, [480, 960, 1600][i]] as const)) {
      expect(inspectImage(file.bytes)).toMatchObject({ mime: "image/webp", width });
      expect((await sharp(file.bytes).metadata()).exif).toBeUndefined();
    }

    const small = await sharp({
      create: { width: 700, height: 400, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer();
    const widths = (
      await createSharpImageProcessor().contentDerivatives(new Uint8Array(small))
    ).map((file) => inspectImage(file.bytes)?.width);
    expect(widths).toEqual([480, 700, 700]);
  });
});
