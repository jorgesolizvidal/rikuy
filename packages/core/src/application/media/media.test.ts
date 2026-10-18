import { describe, expect, it } from "vitest";

import type { OrganizationMembership } from "../../contracts/organization";
import { validatePresentation } from "../../contracts/presentation";
import { inspectImage } from "../../domain/media/image";
import { checkDeclaredLogo, checkUploadedLogo, LOGO_RULES } from "../../domain/media/logo";
import { CONTENT_IMAGE_FILES } from "../../domain/media/rules";
import {
  confirmContentImageUpload,
  publishContentImages,
  requestContentImageUpload,
} from "./content-images";
import { samplePresentation } from "../../testing/presentation-fixture";
import { confirmLogoUpload, publishedLogoPath, requestLogoUpload } from "./logo";
import type { ImageProcessor, ImageVersionRecord, MediaAdmin, MediaRepository } from "./ports";

const TENANT = "5eed1000-0000-4000-8000-000000000001";
const ASSET = "5eed4000-0000-4000-8000-000000000001";
const VERSION = "5eed5000-0000-4000-8000-000000000001";

// ── Minimal image headers ────────────────────────────────────────────────────
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

function jpeg(width: number, height: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [0xff, 0xc2, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, ...new Array(12).fill(0)]);
}

function riff(chunk: string, payload: number[]): Uint8Array {
  const text = (s: string) => [...s].map((c) => c.charCodeAt(0));
  return new Uint8Array([
    ...text("RIFF"),
    0,
    0,
    0,
    0,
    ...text("WEBP"),
    ...text(chunk),
    0,
    0,
    0,
    0,
    ...payload,
    ...new Array(8).fill(0),
  ]);
}

const webpVp8x = (w: number, h: number) =>
  riff("VP8X", [
    0,
    0,
    0,
    0,
    (w - 1) & 255,
    ((w - 1) >> 8) & 255,
    (w - 1) >> 16,
    (h - 1) & 255,
    ((h - 1) >> 8) & 255,
    (h - 1) >> 16,
  ]);
const webpVp8 = (w: number, h: number) =>
  riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, w & 255, w >> 8, h & 255, h >> 8]);
function webpVp8l(w: number, h: number): Uint8Array {
  const bits = (w - 1) | ((h - 1) << 14);
  return riff("VP8L", [
    0x2f,
    bits & 255,
    (bits >> 8) & 255,
    (bits >> 16) & 255,
    (bits >>> 24) & 255,
  ]);
}

describe("image identification by signature", () => {
  it.each([
    ["PNG", png(640, 480), "image/png", 640, 480],
    ["JPEG (progressive)", jpeg(1200, 800), "image/jpeg", 1200, 800],
    ["WebP VP8X", webpVp8x(512, 300), "image/webp", 512, 300],
    ["WebP VP8 (lossy)", webpVp8(320, 200), "image/webp", 320, 200],
    ["WebP VP8L (lossless)", webpVp8l(256, 128), "image/webp", 256, 128],
  ])("reads %s", (_name, bytes, mime, width, height) => {
    expect(inspectImage(bytes)).toEqual({ mime, width, height });
  });

  it.each([
    [
      "SVG",
      new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      ),
    ],
    ["HTML renamed to .png", new TextEncoder().encode("<!doctype html><html></html>")],
    ["GIF", new TextEncoder().encode("GIF89a\x10\x00\x10\x00")],
    ["truncated PNG", png(10, 10).subarray(0, 12)],
    ["zero-size PNG", png(0, 10)],
    ["empty", new Uint8Array()],
  ])("rejects %s", (_name, bytes) => {
    expect(inspectImage(bytes)).toBeNull();
  });
});

describe("logo rules", () => {
  it("checks what the browser declares", () => {
    expect(checkDeclaredLogo("image/png", 1000)).toBeNull();
    expect(checkDeclaredLogo("image/svg+xml", 1000)).toBe("unsupported_type");
    expect(checkDeclaredLogo("image/png", LOGO_RULES.maxBytes + 1)).toBe("too_heavy");
    expect(checkDeclaredLogo("image/png", 0)).toBe("unreadable");
  });

  it("checks the real bytes against the declaration and the size limits", () => {
    expect(checkUploadedLogo(inspectImage(png(512, 256)), 4000, "image/png")).toBeNull();
    expect(checkUploadedLogo(inspectImage(png(512, 256)), 4000, "image/jpeg")).toBe(
      "type_mismatch",
    );
    expect(checkUploadedLogo(inspectImage(png(32, 32)), 400, "image/png")).toBe("too_small");
    expect(checkUploadedLogo(inspectImage(png(5000, 100)), 400, "image/png")).toBe("too_large");
    expect(checkUploadedLogo(null, 400, "image/png")).toBe("unreadable");
  });

  it("accepts a logo reference in the brand but never a URL", () => {
    expect(
      validatePresentation({ ...samplePresentation(), logo: { assetId: ASSET, version: 1 } }).ok,
    ).toBe(true);
    for (const logo of [
      { assetId: "https://x.test/l.png", version: 1 },
      { assetId: ASSET, version: 0 },
      { assetId: ASSET, version: 1, url: "x" },
    ]) {
      expect(validatePresentation({ ...samplePresentation(), logo }).ok).toBe(false);
    }
    expect(publishedLogoPath(TENANT, { assetId: ASSET, version: 2 }, "logo.webp")).toBe(
      `${TENANT}/${ASSET}/2/logo.webp`,
    );
  });
});

// ── Use cases ────────────────────────────────────────────────────────────────
const owner: OrganizationMembership = {
  tenantId: TENANT,
  slug: "demo-norte",
  displayName: "Municipio Demo Norte",
  role: "owner",
  tenantStatus: "active",
};

function fakes(
  options: {
    original?: Uint8Array | null;
    version?: Partial<ImageVersionRecord> | null;
    failProcessing?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const version: ImageVersionRecord | null =
    options.version === null
      ? null
      : {
          versionId: VERSION,
          tenantId: TENANT,
          assetId: ASSET,
          version: 1,
          purpose: "logo",
          status: "uploading",
          declaredMime: "image/png",
          originalPath: `${TENANT}/${ASSET}/1/original`,
          ...options.version,
        };
  const media: MediaRepository = {
    async createImageUpload(tenantId, purpose, mime, bytes) {
      calls.push(`create:${purpose}:${mime}:${bytes}`);
      return {
        status: "created",
        upload: {
          assetId: ASSET,
          versionId: VERSION,
          version: 1,
          originalPath: `${tenantId}/${ASSET}/1/original`,
        },
      };
    },
    signedUploadUrl: async (path) => `https://storage.test/upload/${path}?token=t`,
    findVersion: async () => version,
    signedPreviewUrl: async (path) => `https://storage.test/sign/${path}`,
    signedPreviewUrls: async (paths) =>
      new Map(paths.map((path) => [path, `https://storage.test/sign/${path}`])),
  };
  const admin: MediaAdmin = {
    readOriginal: async () => (options.original === undefined ? png(512, 512) : options.original),
    async storeDerivatives(prefix, files) {
      calls.push(`store:${prefix}:${files.map((f) => f.name).join(",")}`);
    },
    async complete(id, meta) {
      calls.push(`complete:${id}:${meta.mime}:${meta.width}x${meta.height}:${meta.sha256.length}`);
    },
    async reject(id, reason) {
      calls.push(`reject:${id}:${reason}`);
    },
    publish: async () => undefined,
  };
  const processor: ImageProcessor = {
    async logoDerivatives() {
      if (options.failProcessing) throw new Error("corrupt");
      return [
        { name: "logo.webp", contentType: "image/webp", bytes: new Uint8Array([1]) },
        { name: "logo.png", contentType: "image/png", bytes: new Uint8Array([2]) },
      ];
    },
    async contentDerivatives() {
      if (options.failProcessing) throw new Error("corrupt");
      return CONTENT_IMAGE_FILES.map((name) => ({
        name,
        contentType: "image/webp" as const,
        bytes: new Uint8Array([3]),
      }));
    },
  };
  return { media, admin, processor, calls };
}

describe("logo upload use cases", () => {
  it("reserves a version and returns a one-time upload URL", async () => {
    const f = fakes();
    expect(await requestLogoUpload(owner, { mime: "image/png", bytes: 5000 }, f.media)).toEqual({
      status: "upload",
      versionId: VERSION,
      uploadUrl: `https://storage.test/upload/${TENANT}/${ASSET}/1/original?token=t`,
      mime: "image/png",
    });
    expect(f.calls).toEqual(["create:logo:image/png:5000"]);
  });

  it("refuses editors and bad declarations before creating anything", async () => {
    const f = fakes();
    expect(
      await requestLogoUpload(
        { ...owner, role: "editor" },
        { mime: "image/png", bytes: 1 },
        f.media,
      ),
    ).toEqual({ status: "forbidden" });
    expect(await requestLogoUpload(owner, { mime: "image/svg+xml", bytes: 1 }, f.media)).toEqual({
      status: "invalid",
      problem: "unsupported_type",
    });
    expect(f.calls).toEqual([]);
  });

  it("validates the real bytes, stores derivatives and marks the version ready", async () => {
    const f = fakes();
    expect(await confirmLogoUpload(owner, VERSION, f)).toEqual({
      status: "ready",
      logo: { assetId: ASSET, version: 1 },
      previewUrl: `https://storage.test/sign/${TENANT}/${ASSET}/1/logo.webp`,
    });
    expect(f.calls).toEqual([
      `store:${TENANT}/${ASSET}/1/:logo.webp,logo.png`,
      `complete:${VERSION}:image/png:512x512:64`,
    ]);
  });

  it.each([
    [
      "an HTML file declared as PNG",
      new TextEncoder().encode("<html><script>x</script></html>"),
      "unreadable",
    ],
    ["a JPEG declared as PNG", jpeg(400, 400), "type_mismatch"],
    ["a tiny image", png(16, 16), "too_small"],
  ])("rejects %s and deletes the original", async (_name, original, problem) => {
    const f = fakes({ original });
    expect(await confirmLogoUpload(owner, VERSION, f)).toEqual({ status: "rejected", problem });
    expect(f.calls).toEqual([`reject:${VERSION}:${problem}`]);
  });

  it("rejects images the processor cannot decode", async () => {
    const f = fakes({ failProcessing: true });
    expect(await confirmLogoUpload(owner, VERSION, f)).toEqual({
      status: "rejected",
      problem: "unreadable",
    });
  });

  it("does not touch versions of other tenants, other purposes or missing uploads", async () => {
    expect(await confirmLogoUpload(owner, VERSION, fakes({ version: null }))).toEqual({
      status: "not_found",
    });
    expect(
      await confirmLogoUpload(owner, VERSION, fakes({ version: { tenantId: "other" } })),
    ).toEqual({ status: "not_found" });
    expect(
      await confirmLogoUpload(owner, VERSION, fakes({ version: { purpose: "content" } })),
    ).toEqual({ status: "not_found" });
    expect(await confirmLogoUpload(owner, VERSION, fakes({ original: null }))).toEqual({
      status: "not_uploaded",
    });
    expect(await confirmLogoUpload({ ...owner, role: "analyst" }, VERSION, fakes())).toEqual({
      status: "forbidden",
    });
  });
});

describe("content image use cases", () => {
  const editor: OrganizationMembership = { ...owner, role: "editor" };

  it("lets editors upload photos up to 10 MB, never SVG", async () => {
    const f = fakes();
    expect(
      await requestContentImageUpload(editor, { mime: "image/jpeg", bytes: 8_000_000 }, f.media),
    ).toMatchObject({ status: "upload" });
    expect(f.calls).toEqual(["create:content:image/jpeg:8000000"]);
    expect(
      await requestContentImageUpload(editor, { mime: "image/svg+xml", bytes: 10 }, f.media),
    ).toEqual({ status: "invalid", problem: "unsupported_type" });
    expect(
      await requestContentImageUpload(
        { ...owner, role: "analyst" },
        { mime: "image/jpeg", bytes: 10 },
        f.media,
      ),
    ).toEqual({ status: "forbidden" });
  });

  it("stores responsive derivatives and previews the smallest one", async () => {
    const f = fakes({
      version: { purpose: "content", declaredMime: "image/png" },
      original: png(2000, 1500),
    });
    expect(await confirmContentImageUpload(editor, VERSION, f)).toEqual({
      status: "ready",
      image: { assetId: ASSET, version: 1 },
      previewUrl: `https://storage.test/sign/${TENANT}/${ASSET}/1/w480.webp`,
    });
    expect(f.calls[0]).toBe(`store:${TENANT}/${ASSET}/1/:w480.webp,w960.webp,w1600.webp`);
  });

  it("rejects photos too small to look good on a phone", async () => {
    const f = fakes({
      version: { purpose: "content", declaredMime: "image/png" },
      original: png(300, 200),
    });
    expect(await confirmContentImageUpload(editor, VERSION, f)).toEqual({
      status: "rejected",
      problem: "too_small",
    });
  });

  it("does not confirm a logo upload as a content photo", async () => {
    const f = fakes({ version: { purpose: "logo" } });
    expect(await confirmContentImageUpload(editor, VERSION, f)).toEqual({ status: "not_found" });
  });

  it("publishes each referenced image once", async () => {
    const published: string[] = [];
    await publishContentImages(
      TENANT,
      [
        { assetId: ASSET, version: 1 },
        { assetId: ASSET, version: 1 },
        { assetId: VERSION, version: 2 },
      ],
      {
        publish: async (tenant, asset, version, files) => {
          published.push(`${asset}/${version}:${files.length}`);
        },
      },
    );
    expect(published).toEqual([`${ASSET}/1:3`, `${VERSION}/2:3`]);
  });
});
