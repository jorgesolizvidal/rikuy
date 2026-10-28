import { drainJobs } from "@rikuy/core";
import { createMemoryJobLedger } from "@rikuy/core/testing";
import { describe, expect, it } from "vitest";

import { createRemoveUnusedMediaProcessor } from "./remove-unused-media";

const VERSION = "5eed3000-0000-4000-8000-000000000009";
const FOLDER = "5eed1000-0000-4000-8000-000000000001/5eed2000-0000-4000-8000-000000000001/1/";

async function run(options: { folder: string | null; storageFails?: number }) {
  const removed: string[] = [];
  let failures = options.storageFails ?? 0;
  const ledger = createMemoryJobLedger();
  ledger.add({
    jobId: "j",
    kind: "media.remove_unused",
    payload: { versionId: VERSION },
    maxAttempts: 5,
  });
  await drainJobs({
    ledger,
    processors: [
      createRemoveUnusedMediaProcessor({
        unusedMedia: { claim: async () => options.folder },
        folders: {
          async removeVersionFolder(prefix) {
            if (failures > 0) {
              failures -= 1;
              throw new Error("storage answered 503");
            }
            removed.push(prefix);
            return 4;
          },
        },
      }),
    ],
    runnerId: "test",
    budgetMs: 2_000,
  });
  return { job: ledger.jobs.get("j"), removed };
}

describe("media.remove_unused", () => {
  it("removes the folder the ledger hands back", async () => {
    const { job, removed } = await run({ folder: FOLDER });
    expect(job?.status).toBe("succeeded");
    expect(job?.result).toEqual({ outcome: "removed", files: 4 });
    expect(removed).toEqual([FOLDER]);
  });

  it("leaves a version that is used again alone", async () => {
    const { job, removed } = await run({ folder: null });
    expect(job?.result).toEqual({ outcome: "in_use" });
    expect(removed).toEqual([]);
  });

  it("retries when Storage does not answer", async () => {
    const { job, removed } = await run({ folder: FOLDER, storageFails: 1 });
    expect(job?.attempts).toBe(2);
    expect(job?.status).toBe("succeeded");
    expect(removed).toEqual([FOLDER]);
  });

  it("never removes anything broader than one version's folder", async () => {
    for (const folder of [
      "5eed1000-0000-4000-8000-000000000001/",
      "5eed1000-0000-4000-8000-000000000001/5eed2000-0000-4000-8000-000000000001/",
      "../x/1/",
    ]) {
      const { job, removed } = await run({ folder });
      expect(job?.status).toBe("dead_letter");
      expect(removed).toEqual([]);
    }
  });
});
