import { drainJobs, type HeroImageSource } from "@rikuy/core";
import { createMemoryJobLedger } from "@rikuy/core/testing";
import { describe, expect, it } from "vitest";

import { createHeroImagesProcessor } from "./hero-images";

const TENANT = "5eed1000-0000-4000-8000-000000000001";
const ASSET = "5eed2000-0000-4000-8000-000000000001";
const VERSION = "5eed3000-0000-4000-8000-000000000009";
const PREFIX = `${TENANT}/${ASSET}/1/`;

const source = (published: boolean): HeroImageSource => ({
  tenantId: TENANT,
  assetId: ASSET,
  version: 1,
  originalPath: `${PREFIX}original`,
  published,
});

async function run(options: {
  /** What each read of the version answers, in order (the last one repeats). */
  reads: readonly (HeroImageSource | null)[];
  original?: Uint8Array | null;
  corrupt?: boolean;
  storageFails?: number;
  complete?: "done" | "gone" | "missing";
}) {
  const calls: string[] = [];
  let reads = 0;
  let failures = options.storageFails ?? 0;
  const ledger = createMemoryJobLedger();
  ledger.add({
    jobId: "j",
    kind: "media.hero_images",
    payload: { versionId: VERSION },
    maxAttempts: 4,
  });
  await drainJobs({
    ledger,
    processors: [
      createHeroImagesProcessor({
        heroes: {
          async source() {
            const answer = options.reads[Math.min(reads, options.reads.length - 1)] ?? null;
            reads += 1;
            return answer;
          },
          async complete() {
            calls.push("complete");
            return options.complete ?? "done";
          },
        },
        heroMedia: {
          async readOriginal(path) {
            calls.push(`read:${path}`);
            return options.original === undefined ? new Uint8Array([1]) : options.original;
          },
          async storeDerivatives(prefix, files) {
            if (failures > 0) {
              failures -= 1;
              throw new Error("storage answered 503");
            }
            calls.push(`store:${prefix}:${files.map((file) => file.name).join(",")}`);
          },
          async publishFiles(tenant, asset, version, files) {
            calls.push(`public:${tenant}/${asset}/${version}:${files.join(",")}`);
          },
        },
        imageProcessor: {
          async heroDerivatives() {
            if (options.corrupt) throw new Error("corrupt");
            return ["hero-w800.webp", "hero-w1200.webp"].map((name) => ({
              name,
              contentType: "image/webp" as const,
              bytes: new Uint8Array([2]),
            }));
          },
        },
      }),
    ],
    runnerId: "test",
    budgetMs: 2_000,
  });
  return { job: ledger.jobs.get("j"), calls };
}

describe("media.hero_images", () => {
  it("stores the hero versions of a public photo and makes them public before completing", async () => {
    const { job, calls } = await run({ reads: [source(true)] });
    expect(job?.status).toBe("succeeded");
    expect(job?.result).toEqual({ outcome: "done", published: true, files: 2 });
    expect(calls).toEqual([
      `read:${PREFIX}original`,
      `store:${PREFIX}:hero-w800.webp,hero-w1200.webp`,
      `public:${TENANT}/${ASSET}/1:hero-w800.webp,hero-w1200.webp`,
      "complete",
    ]);
  });

  it("keeps them private for a photo that is not public", async () => {
    const { job, calls } = await run({ reads: [source(false)] });
    expect(job?.result).toEqual({ outcome: "done", published: false, files: 2 });
    expect(calls.some((call) => call.startsWith("public:"))).toBe(false);
  });

  it("copies them when the photo became public while they were being made", async () => {
    const { calls } = await run({ reads: [source(false), source(true)] });
    expect(calls).toContain(`public:${TENANT}/${ASSET}/1:hero-w800.webp,hero-w1200.webp`);
  });

  it("does nothing for a version that is gone", async () => {
    const { job, calls } = await run({ reads: [null] });
    expect(job?.result).toEqual({ outcome: "gone" });
    expect(calls).toEqual([]);
  });

  it("does nothing without the original", async () => {
    const { job, calls } = await run({ reads: [source(true)], original: null });
    expect(job?.result).toEqual({ outcome: "no_original" });
    expect(calls).toEqual([`read:${PREFIX}original`]);
  });

  it("retries when Storage does not answer", async () => {
    const { job } = await run({ reads: [source(true)], storageFails: 1 });
    expect(job?.attempts).toBe(2);
    expect(job?.status).toBe("succeeded");
  });

  it("gives up on an original that cannot be decoded", async () => {
    const { job, calls } = await run({ reads: [source(true)], corrupt: true });
    expect(job?.status).toBe("dead_letter");
    expect(calls.some((call) => call.startsWith("store:"))).toBe(false);
  });

  it("retries when the ledger does not find the stored files yet", async () => {
    const { job } = await run({ reads: [source(false)], complete: "missing" });
    expect(job?.attempts).toBe(4);
    expect(job?.status).toBe("dead_letter");
  });
});
