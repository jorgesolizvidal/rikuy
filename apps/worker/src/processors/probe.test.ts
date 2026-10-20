import { drainJobs } from "@rikuy/core";
import { createMemoryJobLedger } from "@rikuy/core/testing";
import { describe, expect, it } from "vitest";

import { processors } from "../index";

describe("system.probe", () => {
  it("succeeds, checkpoints halfway and reports its result", async () => {
    const ledger = createMemoryJobLedger();
    ledger.add({ jobId: "ok", kind: "system.probe", payload: { mode: "ok", workMs: 10 } });
    const report = await drainJobs({ ledger, processors, runnerId: "test", budgetMs: 2_000 });
    expect(report.succeeded).toBe(1);
    expect(ledger.jobs.get("ok")).toMatchObject({
      status: "succeeded",
      checkpoint: { halfway: true },
      result: { mode: "ok", attemptNo: 1, workedMs: 10 },
    });
  });

  it("rehearses one retry and a dead-letter", async () => {
    const ledger = createMemoryJobLedger();
    ledger.add({ jobId: "once", kind: "system.probe", payload: { mode: "fail_once" } });
    ledger.add({ jobId: "always", kind: "system.probe", payload: { mode: "fail_always" } });
    await drainJobs({ ledger, processors, runnerId: "test", budgetMs: 2_000 });
    expect(ledger.jobs.get("once")).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(ledger.jobs.get("always")).toMatchObject({
      status: "dead_letter",
      attempts: 3,
      lastError: { code: "probe_failure", retryable: true },
    });
  });

  it("refuses an invalid payload without retrying", async () => {
    const ledger = createMemoryJobLedger();
    ledger.add({ jobId: "bad", kind: "system.probe", payload: { mode: "rm -rf" } });
    await drainJobs({ ledger, processors, runnerId: "test", budgetMs: 2_000 });
    expect(ledger.jobs.get("bad")).toMatchObject({
      status: "dead_letter",
      attempts: 1,
      lastError: { code: "invalid_payload", retryable: false },
    });
  });
});
