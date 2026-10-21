import { describe, expect, it } from "vitest";

import { probePayloadSchema } from "../../contracts/jobs";
import {
  JobFailure,
  permanentFailure,
  safeJobMessage,
  toJobFailure,
  transientFailure,
} from "../../domain/jobs/failure";
import { createMemoryJobLedger } from "../../testing/memory-job-ledger";
import {
  loadJobAttempts,
  parseJobStatus,
  replayJob,
  requestProbe,
  type JobAdminRepository,
} from "./admin";
import { drainJobs, newRunnerId } from "./drain";
import type { JobLogEvent, JobLogger, JobProcessor } from "./ports";
import { runClaimedJob } from "./run-job";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function processor(kind: string, run: JobProcessor["run"], schemaVersions = [1]): JobProcessor {
  return { kind, schemaVersions, run };
}

function recordingLogger() {
  const events: { name: JobLogEvent; fields: Record<string, unknown> }[] = [];
  const logger: JobLogger = {
    event(name, fields) {
      events.push({ name, fields });
    },
  };
  return { logger, events };
}

async function claimOne(ledger: ReturnType<typeof createMemoryJobLedger>, kind = "test.work") {
  const [job] = await ledger.claim("runner-1", 1, [kind]);
  if (!job) throw new Error("nothing to claim");
  return job;
}

describe("job failures", () => {
  it("keep error codes in the ledger's format", () => {
    expect(transientFailure("storage_unavailable", "x").code).toBe("storage_unavailable");
    expect(permanentFailure("Not Valid", "x").code).toBe("invalid_error_code");
  });

  it("never keep query strings (signed URLs) or long messages", () => {
    expect(safeJobMessage("GET https://s.example.test/o/a.png?token=SECRET&x=1 failed")).toBe(
      "GET https://s.example.test/o/a.png?… failed",
    );
    expect(safeJobMessage("a".repeat(900))).toHaveLength(500);
    expect(safeJobMessage(undefined)).toBe("");
  });

  it("treat unexpected errors as transient", () => {
    const failure = toJobFailure(new TypeError("fetch failed ?sig=abc"));
    expect(failure).toBeInstanceOf(JobFailure);
    expect(failure.retryable).toBe(true);
    expect(failure.code).toBe("unexpected_error");
    expect(failure.message).not.toContain("abc");
  });
});

describe("runClaimedJob", () => {
  it("completes a job and logs without its payload", async () => {
    const ledger = createMemoryJobLedger();
    ledger.add({ jobId: "j1", kind: "test.work", payload: { secret: "do-not-log" } });
    const { logger, events } = recordingLogger();
    const job = await claimOne(ledger);

    const report = await runClaimedJob(job, {
      ledger,
      logger,
      processors: new Map([
        ["test.work", processor("test.work", async () => ({ result: { ok: true }, bytesOut: 10 }))],
      ]),
    });

    expect(report.outcome).toBe("succeeded");
    expect(ledger.jobs.get("j1")).toMatchObject({ status: "succeeded", result: { ok: true } });
    expect(ledger.jobs.get("j1")?.metrics[0]).toMatchObject({ bytesOut: 10 });
    expect(events.map((event) => event.name)).toEqual(["job.started", "job.succeeded"]);
    expect(JSON.stringify(events)).not.toContain("do-not-log");
  });

  it("dead-letters a permanent failure and retries a transient one", async () => {
    const ledger = createMemoryJobLedger();
    ledger.add({ jobId: "bad", kind: "test.work", payload: { fail: "permanent" } });
    ledger.add({ jobId: "flaky", kind: "test.work", payload: { fail: "transient" } });
    const work = processor("test.work", async ({ job }) => {
      const { fail } = job.payload as { fail: string };
      if (fail === "permanent") throw permanentFailure("invalid_source", "not an image");
      if (job.attemptNo === 1) throw transientFailure("storage_unavailable", "try later", 30);
      return {};
    });

    const first = await drainJobs({ ledger, processors: [work], runnerId: "r", budgetMs: 5_000 });
    expect(first.deadLettered).toBe(1);
    expect(ledger.jobs.get("bad")?.status).toBe("dead_letter");
    // The flaky one was retried by the same drain (retries are due at once in memory).
    expect(ledger.jobs.get("flaky")).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(first.retried).toBe(1);
  });

  it("stops writing when the lease is lost (fencing)", async () => {
    const ledger = createMemoryJobLedger();
    ledger.add({ jobId: "j1", kind: "test.work" });
    const job = await claimOne(ledger);
    let sawAbort = false;

    const run = runClaimedJob(job, {
      ledger,
      heartbeatMs: 5,
      processors: new Map([
        [
          "test.work",
          processor("test.work", async ({ signal }) => {
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
            sawAbort = true;
            return { result: { late: true } };
          }),
        ],
      ]),
    });
    ledger.expire("j1");
    await ledger.reapExpired();
    const report = await run;

    expect(report.outcome).toBe("lease_lost");
    expect(sawAbort).toBe(true);
    expect(ledger.calls.completes).toBe(0);
    expect(ledger.jobs.get("j1")?.result).toBeNull();
  });

  it("saves checkpoints and refuses them once the lease is gone", async () => {
    const ledger = createMemoryJobLedger();
    ledger.add({ jobId: "j1", kind: "test.work" });
    const job = await claimOne(ledger);

    const report = await runClaimedJob(job, {
      ledger,
      processors: new Map([
        [
          "test.work",
          processor("test.work", async ({ saveCheckpoint }) => {
            await saveCheckpoint({ level: 1 });
            ledger.expire("j1");
            await saveCheckpoint({ level: 2 });
            return {};
          }),
        ],
      ]),
    });

    expect(report.outcome).toBe("lease_lost");
    expect(ledger.jobs.get("j1")?.checkpoint).toEqual({ level: 1 });
  });

  it("reports a run past its time budget as a transient failure", async () => {
    const ledger = createMemoryJobLedger({ maxActiveSeconds: 0.03 });
    ledger.add({ jobId: "slow", kind: "test.work" });
    const job = await claimOne(ledger);

    const report = await runClaimedJob(job, {
      ledger,
      processors: new Map([
        ["test.work", processor("test.work", async () => (await sleep(200), {}))],
      ]),
    });

    expect(report).toMatchObject({ outcome: "retry", errorCode: "time_budget_exceeded" });
    expect(ledger.jobs.get("slow")?.lastError?.retryable).toBe(true);
  });

  it("dead-letters a kind without processor or an unsupported payload version", async () => {
    const ledger = createMemoryJobLedger();
    ledger.add({ jobId: "v2", kind: "test.work", schemaVersion: 2 });
    const job = await claimOne(ledger);
    const report = await runClaimedJob(job, {
      ledger,
      processors: new Map([["test.work", processor("test.work", async () => ({}))]]),
    });
    expect(report).toMatchObject({
      outcome: "dead_letter",
      errorCode: "unsupported_schema_version",
    });

    ledger.add({ jobId: "orphan", kind: "test.other" });
    const orphan = await claimOne(ledger, "test.other");
    const missing = await runClaimedJob(orphan, { ledger, processors: new Map() });
    expect(missing).toMatchObject({ outcome: "dead_letter", errorCode: "no_processor" });
  });

  it("sanitizes unexpected errors before they reach the ledger", async () => {
    const ledger = createMemoryJobLedger();
    ledger.add({ jobId: "j1", kind: "test.work" });
    const job = await claimOne(ledger);
    await runClaimedJob(job, {
      ledger,
      processors: new Map([
        [
          "test.work",
          processor("test.work", async () => {
            throw new Error("upload to https://x.example.test/a?X-Amz-Signature=SECRET failed");
          }),
        ],
      ]),
    });
    expect(ledger.jobs.get("j1")?.lastError).toMatchObject({
      code: "unexpected_error",
      retryable: true,
    });
    expect(ledger.jobs.get("j1")?.lastError?.message).not.toContain("SECRET");
  });
});

describe("drainJobs", () => {
  it("runs jobs in parallel up to its concurrency and stops when idle", async () => {
    const ledger = createMemoryJobLedger();
    for (const id of ["a", "b", "c", "d"]) ledger.add({ jobId: id, kind: "test.work" });
    let running = 0;
    let peak = 0;
    const work = processor("test.work", async () => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(20);
      running -= 1;
      return {};
    });

    const report = await drainJobs({
      ledger,
      processors: [work],
      runnerId: "r",
      budgetMs: 5_000,
      concurrency: 2,
    });

    expect(report).toMatchObject({ claimed: 4, succeeded: 4, stoppedBecause: "idle" });
    expect(peak).toBe(2);
  });

  it("only claims kinds it can process", async () => {
    const ledger = createMemoryJobLedger();
    ledger.add({ jobId: "mine", kind: "test.work" });
    ledger.add({ jobId: "other", kind: "media.panorama" });
    await drainJobs({
      ledger,
      processors: [processor("test.work", async () => ({}))],
      runnerId: "r",
      budgetMs: 1_000,
    });
    expect(ledger.jobs.get("other")?.status).toBe("pending");
  });

  it("stops claiming when the budget is spent", async () => {
    let clock = 0;
    const ledger = createMemoryJobLedger({ now: () => clock });
    for (const id of ["a", "b", "c"]) ledger.add({ jobId: id, kind: "test.work" });
    const work = processor("test.work", async () => {
      clock += 600;
      return {};
    });
    const report = await drainJobs({
      ledger,
      processors: [work],
      runnerId: "r",
      budgetMs: 1_000,
      now: () => clock,
    });
    expect(report).toMatchObject({ claimed: 2, stoppedBecause: "budget" });
    expect(ledger.jobs.get("c")?.status).toBe("pending");
  });

  it("counts a run whose outcome could not be reported (it will be retried)", async () => {
    const ledger = createMemoryJobLedger();
    ledger.add({ jobId: "a", kind: "test.work" });
    ledger.complete = async () => {
      throw new Error("connection reset");
    };
    const report = await drainJobs({
      ledger,
      processors: [processor("test.work", async () => ({}))],
      runnerId: "r",
      budgetMs: 1_000,
    });
    expect(report).toMatchObject({ claimed: 1, unreported: 1, succeeded: 0 });
  });

  it("builds runner ids the ledger accepts", () => {
    expect(newRunnerId("vercel gru1", () => "3f9a-77")).toBe("vercel-gru1:3f9a77");
    expect(newRunnerId("")).toMatch(/^runner:[A-Za-z0-9]{1,32}$/u);
  });
});

describe("probe payload", () => {
  it("matches what the database accepts", () => {
    expect(probePayloadSchema.parse({})).toEqual({ mode: "ok", workMs: 0 });
    expect(probePayloadSchema.safeParse({ mode: "rm -rf" }).success).toBe(false);
    expect(probePayloadSchema.safeParse({ workMs: 20_000 }).success).toBe(false);
    expect(probePayloadSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("job administration", () => {
  const calls: unknown[] = [];
  const repository: JobAdminRepository = {
    summary: async () => ({
      pending: 0,
      due: 0,
      running: 0,
      deadLetter: 0,
      succeededLastDay: 0,
      oldestDueAt: null,
      checkedAt: "2026-10-20T10:00:00Z",
    }),
    list: async () => [],
    attempts: async (jobId) => (calls.push(["attempts", jobId]), []),
    replay: async (jobId, generation) => (
      calls.push(["replay", jobId, generation]),
      { status: "replayed", generation: generation + 1 }
    ),
    enqueueProbe: async (tenantId, mode) => (
      calls.push(["probe", tenantId, mode]),
      { status: "enqueued", jobId: "j" }
    ),
  };
  const id = "5eed1000-0000-4000-8000-000000000001";

  it("validates input before reaching the ledger", async () => {
    expect(parseJobStatus("dead_letter")).toBe("dead_letter");
    expect(parseJobStatus("drop table")).toBeNull();
    expect(await loadJobAttempts(repository, "nope")).toBeNull();
    expect(await replayJob(repository, { jobId: "nope", generation: 1 })).toEqual({
      status: "not_found",
    });
    expect(await replayJob(repository, { jobId: id, generation: "x" })).toEqual({
      status: "stale",
    });
    expect(await requestProbe(repository, { tenantId: id, mode: "drop" })).toEqual({
      status: "invalid",
    });
    expect(calls).toEqual([]);

    expect(await replayJob(repository, { jobId: id, generation: "2" })).toEqual({
      status: "replayed",
      generation: 3,
    });
    expect(await requestProbe(repository, { tenantId: id, mode: undefined })).toEqual({
      status: "enqueued",
      jobId: "j",
    });
    expect(calls).toEqual([
      ["replay", id, 2],
      ["probe", id, "ok"],
    ]);
  });
});
