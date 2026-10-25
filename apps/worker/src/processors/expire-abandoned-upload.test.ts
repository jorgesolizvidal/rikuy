import { drainJobs, type AbandonedUploadStore } from "@rikuy/core";
import { createMemoryJobLedger } from "@rikuy/core/testing";
import { describe, expect, it } from "vitest";

import { createExpireAbandonedUploadProcessor } from "./expire-abandoned-upload";

const VERSION = "5eed3000-0000-4000-8000-000000000009";
const PATH = `t/a/1/original`;

function fakes(state: { abandoned: boolean; marked?: number; storageFails?: number }) {
  const removed: string[] = [];
  let failures = state.storageFails ?? 0;
  let status: "uploading" | "rejected" = state.abandoned ? "uploading" : "rejected";
  const uploads: AbandonedUploadStore = {
    async inspect() {
      return { abandoned: status === "uploading", originalPath: PATH };
    },
    async markAbandoned() {
      if (status !== "uploading") return "already_settled";
      status = "rejected";
      return "marked";
    },
  };
  const storage = {
    async removeOriginal(path: string) {
      if (failures > 0) {
        failures -= 1;
        throw new Error("storage answered 503 for https://s.example.test/o?token=SECRET");
      }
      removed.push(path);
    },
  };
  return { uploads, storage, removed, status: () => status };
}

async function run(deps: ReturnType<typeof fakes>, payload: unknown = { versionId: VERSION }) {
  const ledger = createMemoryJobLedger();
  ledger.add({ jobId: "j", kind: "media.expire_abandoned_upload", payload, maxAttempts: 5 });
  await drainJobs({
    ledger,
    processors: [createExpireAbandonedUploadProcessor(deps)],
    runnerId: "test",
    budgetMs: 2_000,
  });
  return ledger.jobs.get("j");
}

describe("media.expire_abandoned_upload", () => {
  it("removes the original and rejects the version", async () => {
    const deps = fakes({ abandoned: true });
    const job = await run(deps);
    expect(job).toMatchObject({ status: "succeeded", result: { outcome: "marked" } });
    expect(deps.removed).toEqual([PATH]);
    expect(deps.status()).toBe("rejected");
  });

  it("does nothing when the upload was settled meanwhile", async () => {
    const deps = fakes({ abandoned: false });
    const job = await run(deps);
    expect(job).toMatchObject({ status: "succeeded", result: { outcome: "nothing_to_do" } });
    expect(deps.removed).toEqual([]);
  });

  it("retries when storage does not answer, without keeping signed URLs", async () => {
    const deps = fakes({ abandoned: true, storageFails: 1 });
    const job = await run(deps);
    expect(job).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(deps.removed).toEqual([PATH]);
    const ledger = createMemoryJobLedger();
    ledger.add({
      jobId: "x",
      kind: "media.expire_abandoned_upload",
      payload: { versionId: VERSION },
      maxAttempts: 1,
    });
    await drainJobs({
      ledger,
      processors: [
        createExpireAbandonedUploadProcessor(fakes({ abandoned: true, storageFails: 1 })),
      ],
      runnerId: "test",
      budgetMs: 2_000,
    });
    expect(ledger.jobs.get("x")?.lastError).toMatchObject({
      code: "storage_unavailable",
      retryable: true,
    });
    expect(ledger.jobs.get("x")?.lastError?.message).not.toContain("SECRET");
  });

  it("is idempotent after a crash between removing and marking", async () => {
    const deps = fakes({ abandoned: true });
    // First run removed the object but "died" before marking: the object is already gone.
    deps.removed.push(PATH);
    const job = await run(deps);
    expect(job?.status).toBe("succeeded");
    expect(deps.status()).toBe("rejected");
  });

  it("stops when the lease is lost, before touching storage", async () => {
    const deps = fakes({ abandoned: true });
    deps.uploads.inspect = async () => "lease_lost";
    const job = await run(deps);
    expect(deps.removed).toEqual([]);
    expect(job?.status).not.toBe("succeeded");
  });

  it("refuses an invalid payload without retrying", async () => {
    const job = await run(fakes({ abandoned: true }), { versionId: "nope" });
    expect(job).toMatchObject({
      status: "dead_letter",
      attempts: 1,
      lastError: { code: "invalid_payload" },
    });
  });
});
