import { describe, expect, it } from "vitest";

import { modelManifestSchema, type ModelManifest } from "../../contracts/model";
import {
  checkDeclaredModel,
  isGlb,
  manifestLabel,
  modelWeight,
  TEXTURE_TOLERANCE,
  withinTolerance,
} from "../../domain/media/model";
import {
  loadModels,
  requestModelUpload,
  saveModelPoster,
  submitModel,
  type ModelRepository,
} from "./models";
import type { ImageVersionRecord, MediaRepository } from "./ports";

const editor = {
  tenantId: "t",
  slug: "t",
  displayName: "T",
  role: "editor" as const,
  tenantStatus: "active" as const,
};
const analyst = { ...editor, role: "analyst" as const };
const VERSION = "5eed9000-0000-4000-8000-000000000001";

function glbHeader(length = 32): Uint8Array {
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, length, true);
  return bytes;
}

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

const manifest: ModelManifest = {
  version: 1,
  format: "glb",
  source: {
    bytes: 482_828,
    sha256: "a".repeat(64),
    triangles: 15_177,
    vertices: 4612,
    materials: 4,
    textures: 11,
    generator: "Blender",
    extensions: ["KHR_draco_mesh_compression"],
  },
  model: {
    file: "model.glb",
    bytes: 1_250_000,
    triangles: 15_177,
    geometry: "meshopt",
    textures: [
      {
        name: "base",
        usage: "color",
        width: 1024,
        height: 1024,
        encoding: "etc1s",
        bytes: 39_437,
        check: { mean: 1.45, p95: 2.21 },
      },
    ],
  },
  colors: { materials: "unchanged", vertexColors: null, suspects: [] },
  weight: "light",
  poster: null,
};

describe("model rules (ADR-026)", () => {
  it("accepts only GLB declarations up to 50 MB", () => {
    expect(checkDeclaredModel("model/gltf-binary", 40_000_000)).toBeNull();
    expect(checkDeclaredModel("model/gltf+json", 10)).toBe("unsupported_type");
    expect(checkDeclaredModel("application/octet-stream", 10)).toBe("unsupported_type");
    expect(checkDeclaredModel("model/gltf-binary", 60_000_000)).toBe("too_heavy");
    expect(checkDeclaredModel("model/gltf-binary", 0)).toBe("unreadable");
  });

  it("recognizes a binary glTF 2.0 by its header, with a matching length", () => {
    expect(isGlb(glbHeader())).toBe(true);
    const truncated = glbHeader(64).slice(0, 40);
    expect(isGlb(truncated)).toBe(false);
    expect(isGlb(png(10, 10))).toBe(false);
    const v1 = glbHeader();
    new DataView(v1.buffer).setUint32(4, 1, true);
    expect(isGlb(v1)).toBe(false);
  });

  it("classifies the optimized weight with the performance budget", () => {
    expect(modelWeight(1_250_000)).toBe("light");
    expect(modelWeight(8_000_000)).toBe("heavy");
    expect(modelWeight(16_000_000)).toBe("too_heavy");
  });

  it("compares a measured drift with the tolerance of its usage", () => {
    expect(withinTolerance({ mean: 1.45, p95: 2.21 }, TEXTURE_TOLERANCE.color)).toBe(true);
    expect(withinTolerance({ mean: 1.45, p95: 5 }, TEXTURE_TOLERANCE.color)).toBe(false);
    expect(withinTolerance({ mean: 1.6, p95: 4.8 }, TEXTURE_TOLERANCE.normal)).toBe(true);
  });

  it("keeps author names short and without parent paths", () => {
    expect(manifestLabel("Ametralladora_MNegro_metallicRoughness", "x")).toBe(
      "Ametralladora_MNegro_metallicRoughness",
    );
    expect(manifestLabel("../../etc", "x")).toBe("././etc");
    expect(manifestLabel("../../etc", "x")).not.toContain("..");
    expect(manifestLabel("a..b", "x")).toBe("a.b");
    expect(manifestLabel("", "Textura 3")).toBe("Textura 3");
    expect(manifestLabel("x".repeat(200), "y")).toHaveLength(80);
  });

  it("validates the manifest the pipeline writes", () => {
    expect(modelManifestSchema.safeParse(manifest).success).toBe(true);
    const heavy = { ...manifest, model: { ...manifest.model, bytes: 16_000_000 } };
    expect(modelManifestSchema.safeParse(heavy).success).toBe(false);
    const escaping = {
      ...manifest,
      colors: { ...manifest.colors, suspects: [{ material: "a", texture: "../b" }] },
    };
    expect(modelManifestSchema.safeParse(escaping).success).toBe(false);
  });
});

function setup(
  options: {
    version?: Partial<ImageVersionRecord> | null;
    posterOutcome?: "saved" | "not_ready";
  } = {},
) {
  const calls: string[] = [];
  const media: MediaRepository = {
    createImageUpload: async (_tenant, purpose, mime, bytes) => {
      calls.push(`create:${purpose}:${mime}:${bytes}`);
      return {
        status: "created",
        upload: { assetId: "a", versionId: VERSION, version: 1, originalPath: "t/a/1/original" },
      };
    },
    signedUploadUrl: async () => "https://upload.example.test/x",
    findVersion: async () =>
      options.version === null
        ? null
        : {
            versionId: VERSION,
            tenantId: "t",
            assetId: "a",
            version: 1,
            purpose: "model",
            status: "ready",
            declaredMime: "model/gltf-binary",
            originalPath: "t/a/1/original",
            ...options.version,
          },
    signedPreviewUrl: async () => null,
    signedPreviewUrls: async (paths) =>
      new Map(paths.map((path) => [path, `https://signed.example.test/${path}`])),
  };
  const models: ModelRepository = {
    list: async () => [
      {
        versionId: VERSION,
        assetId: "a",
        version: 1,
        status: "ready",
        declaredBytes: 482_828,
        problem: null,
        manifest: {
          ...manifest,
          poster: { file: "poster.webp", width: 1280, height: 960, bytes: 1 },
        },
        createdAt: "",
        readyAt: "",
        job: null,
      },
    ],
    submit: async () => "processing",
    setPoster: async (_tenant, _version, poster) => {
      calls.push(`poster:${poster.width}x${poster.height}:${poster.bytes}`);
      return options.posterOutcome ?? "saved";
    },
  };
  const admin = {
    storeDerivatives: async (prefix: string, files: readonly { name: string }[]) => {
      calls.push(`store:${prefix}${files.map((f) => f.name).join(",")}`);
    },
  };
  const processor = {
    modelPoster: async () => ({
      file: { name: "x", contentType: "image/webp" as const, bytes: new Uint8Array(90) },
      width: 1280,
      height: 960,
    }),
  };
  return { calls, deps: { media, models, admin, processor } };
}

describe("model uploads and posters", () => {
  it("reserves a GLB upload for editors, never for analysts", async () => {
    const { calls, deps } = setup();
    expect(
      await requestModelUpload(editor, { mime: "model/gltf-binary", bytes: 482_828 }, deps.media),
    ).toMatchObject({ status: "upload", versionId: VERSION, mime: "model/gltf-binary" });
    expect(calls).toEqual(["create:model:model/gltf-binary:482828"]);
    expect(
      await requestModelUpload(analyst, { mime: "model/gltf-binary", bytes: 10 }, deps.media),
    ).toEqual({ status: "forbidden" });
    expect(await requestModelUpload(editor, { mime: "", bytes: 10 }, deps.media)).toEqual({
      status: "invalid",
      problem: "unsupported_type",
    });
  });

  it("submits only valid version ids, and only for editors and above", async () => {
    const { deps } = setup();
    expect(await submitModel(editor, VERSION, deps.models)).toBe("processing");
    expect(await submitModel(editor, "../etc", deps.models)).toBe("not_found");
    expect(await submitModel(analyst, VERSION, deps.models)).toBe("forbidden");
  });

  it("signs the optimized model and its poster for the list", async () => {
    const { deps } = setup();
    const { cards, canUpload } = await loadModels(editor, deps);
    expect(canUpload).toBe(true);
    expect(cards[0]?.modelUrl).toBe("https://signed.example.test/t/a/1/model/model.glb");
    expect(cards[0]?.posterUrl).toBe("https://signed.example.test/t/a/1/model/poster.webp");
  });

  it("stores the re-encoded poster next to the model and records it", async () => {
    const { calls, deps } = setup();
    expect(
      await saveModelPoster(editor, { versionId: VERSION, capture: png(1600, 1200) }, deps),
    ).toBe("saved");
    expect(calls).toEqual(["store:t/a/1/model/poster.webp", "poster:1280x960:90"]);
  });

  it("refuses posters it should not store", async () => {
    const capture = png(1600, 1200);
    expect(await saveModelPoster(analyst, { versionId: VERSION, capture }, setup().deps)).toBe(
      "forbidden",
    );
    expect(
      await saveModelPoster(
        editor,
        { versionId: VERSION, capture: new Uint8Array(10) },
        setup().deps,
      ),
    ).toBe("invalid");
    expect(
      await saveModelPoster(editor, { versionId: VERSION, capture: png(32, 32) }, setup().deps),
    ).toBe("invalid");
    for (const version of [null, { tenantId: "other" }, { purpose: "content" as const }]) {
      const { calls, deps } = setup({ version });
      expect(await saveModelPoster(editor, { versionId: VERSION, capture }, deps)).toBe(
        "not_found",
      );
      expect(calls).toEqual([]);
    }
    const { calls, deps } = setup({ version: { status: "processing" } });
    expect(await saveModelPoster(editor, { versionId: VERSION, capture }, deps)).toBe("not_ready");
    expect(calls).toEqual([]);
  });
});

describe("color math", () => {
  it("measures perceptual differences in CIELAB", async () => {
    const { deltaE, linearToSrgb, rasterDeltaE, srgbToLab, srgbToLinear } =
      await import("../../domain/media/color");
    expect(deltaE(srgbToLab(1, 1, 1), srgbToLab(1, 1, 1))).toBe(0);
    expect(srgbToLab(1, 1, 1)[0]).toBeCloseTo(100, 1);
    // Gold vs a teal-blue: obviously different.
    expect(deltaE(srgbToLab(0.83, 0.69, 0.22), srgbToLab(0, 0.48, 0.73))).toBeGreaterThan(50);
    // One step of 8-bit quantization is far below what people notice.
    expect(deltaE(srgbToLab(0.5, 0.5, 0.5), srgbToLab(0.5 + 1 / 255, 0.5, 0.5))).toBeLessThan(1);
    expect(linearToSrgb(srgbToLinear(0.42))).toBeCloseTo(0.42, 6);
    const a = new Uint8Array([200, 40, 30, 255, 0, 0, 0, 0]);
    const b = new Uint8Array([200, 40, 30, 255, 255, 255, 255, 0]);
    // The second pixel is transparent in both: not compared.
    expect(rasterDeltaE(a, b, 4)).toEqual({ mean: 0, p95: 0 });
  });
});
