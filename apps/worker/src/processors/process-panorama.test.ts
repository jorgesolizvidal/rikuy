import {
  drainJobs,
  type DerivedFile,
  type PanoramaManifest,
  type PanoramaRenderer,
  type PanoramaStore,
} from "@rikuy/core";
import { createMemoryJobLedger } from "@rikuy/core/testing";
import { describe, expect, it } from "vitest";

import { createProcessPanoramaProcessor } from "./process-panorama";

const VERSION = "5eed3000-0000-4000-8000-000000000042";
const PREFIX = "t/a/1/";

/** Just a PNG header with the given size: what the byte inspector reads. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

const file = (name: string): DerivedFile => ({
  name,
  contentType: "image/webp",
  bytes: new Uint8Array([1, 2, 3]),
});

function setup(options: {
  width: number;
  height: number;
  storageFails?: number;
  renderFails?: boolean;
}) {
  let status: "processing" | "ready" | "rejected" = "processing";
  let manifest: PanoramaManifest | null = null;
  let rejectedWith: string | null = null;
  let failures = options.storageFails ?? 0;
  const stored: string[] = [];
  const removed: string[] = [];
  const tileCalls: number[] = [];

  const panoramas: PanoramaStore = {
    async source() {
      return {
        status,
        originalPath: `${PREFIX}original`,
        declaredMime: "image/png",
        prefix: PREFIX,
      };
    },
    async complete(_lease, _metadata, written) {
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
  const renderer: PanoramaRenderer = {
    async preview(_original, plan) {
      if (options.renderFails) throw new Error("VipsJpeg: premature end of input");
      return { file: file("preview.webp"), ...plan.preview };
    },
    async image(_original, plan) {
      return { file: file("image.webp"), ...plan.image };
    },
    async tiles(_original, level) {
      tileCalls.push(level.width);
      return Array.from({ length: level.cols * level.rows }, (_, i) => file(`${i}.webp`));
    },
  };
  const media = {
    async readOriginal() {
      return pngHeader(options.width, options.height);
    },
    async storeDerivatives(prefix: string, files: readonly DerivedFile[]) {
      if (failures > 0) {
        failures -= 1;
        throw new Error("upload to https://s.example.test/x?token=SECRET failed");
      }
      stored.push(...files.map((f) => `${prefix}${f.name}`));
    },
    async removeOriginal(path: string) {
      removed.push(path);
    },
  };
  return {
    deps: { panoramas, renderer, media },
    state: () => ({ status, manifest, rejectedWith, stored, removed, tileCalls }),
  };
}

async function run(deps: ReturnType<typeof setup>["deps"], maxAttempts = 4) {
  const ledger = createMemoryJobLedger();
  ledger.add({
    jobId: "j",
    kind: "media.process_panorama",
    payload: { versionId: VERSION },
    maxAttempts,
  });
  await drainJobs({
    ledger,
    processors: [createProcessPanoramaProcessor(deps)],
    runnerId: "test",
    budgetMs: 5_000,
  });
  return ledger.jobs.get("j");
}

describe("media.process_panorama", () => {
  it("up to 4096 px: preview + one image, no tiles, original untouched", async () => {
    const { deps, state } = setup({ width: 2880, height: 1440 });
    const job = await run(deps);
    expect(job).toMatchObject({ status: "succeeded", result: { outcome: "ready", tiles: false } });
    const { manifest, stored, removed } = state();
    expect(manifest).toMatchObject({
      version: 1,
      projection: "equirectangular",
      source: { width: 2880, height: 1440, mime: "image/png" },
      preview: { file: "preview.webp", width: 1024 },
      image: { file: "image.webp", width: 2880, height: 1440 },
      tiles: null,
    });
    expect(stored).toEqual([`${PREFIX}panorama/preview.webp`, `${PREFIX}panorama/image.webp`]);
    expect(removed).toEqual([]);
  });

  it("above 4096 px: tiles in every level, under the version's panorama/ folder", async () => {
    const { deps, state } = setup({ width: 8192, height: 4096 });
    await run(deps);
    const { manifest, stored } = state();
    expect(manifest?.image.width).toBe(4096);
    expect(manifest?.tiles?.levels.map((level) => level.dir)).toEqual([
      "tiles/0",
      "tiles/1",
      "tiles/2",
    ]);
    expect(stored).toHaveLength(2 + 168);
    expect(stored).toContain(`${PREFIX}panorama/tiles/2/127.webp`);
  });

  it("rejects an image that is not 2:1, removing its original", async () => {
    const { deps, state } = setup({ width: 4000, height: 3000 });
    const job = await run(deps);
    expect(job).toMatchObject({
      status: "succeeded",
      result: { outcome: "rejected", problem: "not_equirectangular" },
    });
    expect(state()).toMatchObject({
      status: "rejected",
      rejectedWith: "not_equirectangular",
      removed: [`${PREFIX}original`],
    });
  });

  it("rejects a file the renderer cannot decode", async () => {
    const { deps, state } = setup({ width: 4096, height: 2048, renderFails: true });
    await run(deps);
    expect(state()).toMatchObject({ status: "rejected", rejectedWith: "unreadable" });
  });

  it("resumes from its checkpoint after a storage failure, skipping finished levels", async () => {
    // Preview, image and two levels succeed; the third level's upload fails once.
    const { deps, state } = setup({ width: 8192, height: 4096 });
    let calls = 0;
    const store = deps.media.storeDerivatives;
    deps.media.storeDerivatives = async (prefix, files) => {
      calls += 1;
      if (calls === 5) throw new Error("storage answered 503");
      return store(prefix, files);
    };
    const job = await run(deps);
    expect(job).toMatchObject({ status: "succeeded", attempts: 2 });
    // The second attempt rendered only the level that failed.
    expect(state().tileCalls).toEqual([2048, 4096, 8192, 8192]);
    expect(state().status).toBe("ready");
  });

  it("does nothing for a panorama that is no longer processing", async () => {
    const { deps } = setup({ width: 4096, height: 2048 });
    deps.panoramas.source = async () => ({
      status: "ready",
      originalPath: "x",
      declaredMime: "image/png",
      prefix: PREFIX,
    });
    expect(await run(deps)).toMatchObject({
      status: "succeeded",
      result: { outcome: "already_settled" },
    });
  });

  it("keeps no signed URL in its error", async () => {
    const { deps } = setup({ width: 4096, height: 2048, storageFails: 9 });
    const job = await run(deps, 1);
    expect(job?.lastError).toMatchObject({ code: "storage_unavailable", retryable: true });
    expect(job?.lastError?.message).not.toContain("SECRET");
  });
});
