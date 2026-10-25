import {
  drainJobs,
  type DerivedFile,
  type ModelAnalysis,
  type ModelManifest,
  type ModelOptimizer,
  type ModelStore,
} from "@rikuy/core";
import { createMemoryJobLedger } from "@rikuy/core/testing";
import { describe, expect, it } from "vitest";

import { createProcessModelProcessor } from "./process-model";

const VERSION = "5eed3000-0000-4000-8000-000000000077";
const PREFIX = "t/a/1/";

function glb(length = 64): Uint8Array {
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, length, true);
  return bytes;
}

const ANALYSIS: ModelAnalysis = {
  ok: true,
  source: {
    triangles: 15_177,
    vertices: 4612,
    materials: 4,
    textures: 3,
    generator: "Blender",
    extensions: ["KHR_draco_mesh_compression"],
  },
  textures: [
    {
      index: 0,
      name: "base",
      usage: "color",
      width: 1024,
      height: 1024,
      bytes: 9000,
      encodable: true,
    },
    {
      index: 1,
      name: "noisy",
      usage: "data",
      width: 1024,
      height: 1024,
      bytes: 8000,
      encodable: true,
    },
    {
      index: 2,
      name: "already",
      usage: "normal",
      width: 512,
      height: 512,
      bytes: 7000,
      encodable: false,
    },
  ],
  suspects: [{ material: "Dorado", texture: "MNegro_metallicRoughness" }],
};

function setup(
  options: {
    original?: Uint8Array;
    analysis?: ModelAnalysis;
    /** Texture index → check per encoding. */
    drift?: Record<number, Partial<Record<"etc1s" | "uastc", number>>>;
    assembled?: Partial<Awaited<ReturnType<ModelOptimizer["assemble"]>>>;
    failStoreOf?: string;
  } = {},
) {
  let status: "processing" | "ready" | "rejected" = "processing";
  let manifest: ModelManifest | null = null;
  let rejectedWith: string | null = null;
  let failStore = options.failStoreOf;
  const files = new Map<string, Uint8Array>();
  const removed: string[] = [];
  const encodes: string[] = [];

  const models: ModelStore = {
    async source() {
      return {
        status,
        originalPath: `${PREFIX}original`,
        declaredMime: "model/gltf-binary",
        prefix: PREFIX,
      };
    },
    async complete(_lease, _original, written) {
      if (status !== "processing") return "already_settled";
      status = "ready";
      manifest = written;
      return "ready";
    },
    async reject(_lease, problem) {
      if (status !== "processing") return "already_settled";
      status = "rejected";
      rejectedWith = problem;
      return "rejected";
    },
  };
  const optimizer: ModelOptimizer = {
    analyze: async () => options.analysis ?? ANALYSIS,
    async encodeTexture(_original, index, encoding) {
      encodes.push(`${index}:${encoding}`);
      const mean = options.drift?.[index]?.[encoding] ?? 1;
      return {
        bytes: new Uint8Array([index, 1, 2]),
        width: 1024,
        height: 1024,
        check: { mean, p95: mean * 2 },
      };
    },
    async assemble(_original, textures) {
      return {
        glb: new Uint8Array(1000 + textures.size),
        triangles: 15_177,
        vertexColors: null,
        materialsUnchanged: true,
        ...options.assembled,
      };
    },
  };
  const media = {
    async readOriginal(path: string) {
      if (path === `${PREFIX}original`) return options.original ?? glb();
      return files.get(path) ?? null;
    },
    async storeDerivatives(prefix: string, written: readonly DerivedFile[]) {
      for (const file of written) {
        if (failStore && file.name === failStore) {
          failStore = undefined;
          throw new Error("upload to https://s.example.test/x?token=SECRET failed");
        }
        files.set(`${prefix}${file.name}`, file.bytes);
      }
    },
    async removeOriginal(path: string) {
      removed.push(path);
      files.delete(path);
    },
  };
  return {
    deps: { models, optimizer, media },
    state: () => ({
      status,
      manifest,
      rejectedWith,
      files: [...files.keys()].sort(),
      removed,
      encodes,
    }),
  };
}

async function run(deps: ReturnType<typeof setup>["deps"], maxAttempts = 4) {
  const ledger = createMemoryJobLedger();
  ledger.add({
    jobId: "j",
    kind: "media.process_model",
    payload: { versionId: VERSION },
    maxAttempts,
  });
  await drainJobs({
    ledger,
    processors: [createProcessModelProcessor(deps)],
    runnerId: "test",
    budgetMs: 5_000,
  });
  return ledger.jobs.get("j");
}

describe("media.process_model", () => {
  it("encodes each texture (ETC1S, else UASTC, else original) and writes the model", async () => {
    const { deps, state } = setup({ drift: { 1: { etc1s: 9, uastc: 1 } } });
    const job = await run(deps);
    expect(job).toMatchObject({
      status: "succeeded",
      result: { outcome: "ready", weight: "light", suspects: 1 },
    });
    const { manifest, files, removed, encodes } = state();
    expect(encodes).toEqual(["0:etc1s", "1:etc1s", "1:uastc"]);
    expect(manifest?.model.textures.map((t) => `${t.name}:${t.encoding}`)).toEqual([
      "base:etc1s",
      "noisy:uastc",
      "already:original",
    ]);
    expect(manifest).toMatchObject({
      format: "glb",
      source: { bytes: 64, triangles: 15_177 },
      model: { file: "model.glb", bytes: 1002, geometry: "meshopt" },
      colors: { materials: "unchanged", suspects: [{ material: "Dorado" }] },
      poster: null,
    });
    // The KTX2 kept between attempts is removed once the model is done; the original stays.
    expect(files).toEqual([`${PREFIX}model/model.glb`]);
    expect(removed).toEqual([`${PREFIX}model/work/0.ktx2`, `${PREFIX}model/work/1.ktx2`]);
  });

  it("keeps the original image when no KTX2 encoding keeps its colors", async () => {
    const { deps, state } = setup({ drift: { 0: { etc1s: 9, uastc: 5 } } });
    await run(deps);
    expect(state().manifest?.model.textures[0]).toMatchObject({
      encoding: "original",
      check: null,
      bytes: 9000,
    });
  });

  it.each([
    ["not a GLB", { original: new Uint8Array(64) }, "not_glb"],
    [
      "external files",
      { analysis: { ok: false, problem: "external_files" } as const },
      "external_files",
    ],
    ["colors changed", { assembled: { materialsUnchanged: false } }, "colors_changed"],
    [
      "vertex colors drifted",
      { assembled: { vertexColors: { mean: 3, p95: 6 } } },
      "colors_changed",
    ],
    [
      "too heavy optimized",
      { assembled: { glb: new Uint8Array(16 * 1024 * 1024) } },
      "too_heavy_optimized",
    ],
  ] as const)("rejects %s, removing its original", async (_label, options, problem) => {
    const { deps, state } = setup(options);
    const job = await run(deps);
    expect(job).toMatchObject({ status: "succeeded", result: { outcome: "rejected", problem } });
    expect(state()).toMatchObject({ status: "rejected", rejectedWith: problem });
    expect(state().removed).toContain(`${PREFIX}original`);
  });

  it("marks a model between 5 and 15 MB as heavy", async () => {
    const { deps, state } = setup({ assembled: { glb: new Uint8Array(8 * 1024 * 1024) } });
    await run(deps);
    expect(state().manifest?.weight).toBe("heavy");
  });

  it("resumes from its checkpoint: textures are not encoded twice", async () => {
    const { deps, state } = setup({ failStoreOf: "model.glb" });
    const job = await run(deps);
    expect(job).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(state().encodes).toEqual(["0:etc1s", "1:etc1s"]);
    expect(state().status).toBe("ready");
  });

  it("keeps no signed URL in its error", async () => {
    const { deps } = setup({ failStoreOf: "work/0.ktx2" });
    const job = await run(deps, 1);
    expect(job?.lastError).toMatchObject({ code: "storage_unavailable", retryable: true });
    expect(job?.lastError?.message).not.toContain("SECRET");
  });

  it("does nothing for a model that is no longer processing", async () => {
    const { deps } = setup();
    deps.models.source = async () => ({
      status: "ready",
      originalPath: "x",
      declaredMime: "",
      prefix: PREFIX,
    });
    expect(await run(deps)).toMatchObject({
      status: "succeeded",
      result: { outcome: "already_settled" },
    });
  });
});
