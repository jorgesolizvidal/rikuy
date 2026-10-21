/**
 * D-01 · durability of the job ledger against a REAL PostgreSQL (the local Supabase stack
 * in CI), with several runners at once and injected crashes:
 *
 * - an accepted intent never disappears; every job ends with exactly one success;
 * - a runner that dies mid-way (after a checkpoint, before reporting) loses its lease,
 *   another runner resumes from the checkpoint, and the dead one cannot write any more;
 * - duplicated enqueues create one job;
 * - a lease that expired while its old runner is still alive is fenced off;
 * - exhausted jobs are visible in the dead-letter queue and a replay runs them again;
 * - tenant B advances while tenant A saturates the queue;
 * - the workload role can do nothing but call worker_api.
 *
 * The runners connect as `postgres` and act as rikuy_worker (SET ROLE at connection),
 * exactly the privileges the cloud worker has.
 */
import {
  drainJobs,
  probePayloadSchema,
  transientFailure,
  type ClaimedJob,
  type JobLedger,
  type JobProcessor,
} from "@rikuy/core";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPostgresJobLedger, type PostgresJobLedger } from "./job-ledger";

const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const NORTE = "5eed1000-0000-4000-8000-000000000001";
const SUR = "5eed1000-0000-4000-8000-000000000002";
const RUN = Math.random().toString(36).slice(2, 10);

const admin = postgres(DB_URL, { max: 2, prepare: false, onnotice: () => undefined });
const reachable = await admin`select 1`.then(
  () => true,
  () => false,
);
if (process.env.CI && !reachable) throw new Error(`The database at ${DB_URL} is not reachable`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The probe, as the worker runs it (apps/worker cannot be imported from a package). */
const probe: JobProcessor = {
  kind: "system.probe",
  schemaVersions: [1],
  async run({ job, saveCheckpoint }) {
    const { mode, workMs } = probePayloadSchema.parse(job.payload);
    await sleep(workMs);
    await saveCheckpoint({ halfway: true });
    if (mode === "fail_always" || (mode === "fail_once" && job.attemptNo === 1)) {
      throw transientFailure("probe_failure", `Probe failure requested (${mode}).`);
    }
    return { result: { resumedFrom: job.checkpoint, attemptNo: job.attemptNo } };
  },
};

async function enqueue(tenantId: string, key: string, payload: object = {}) {
  const [row] = await admin`
    select job_id from private.enqueue_job(${tenantId}::uuid, 'system.probe', ${`${RUN}:${key}`},
      ${admin.json(payload as Parameters<typeof admin.json>[0])}::jsonb)
  `;
  return String(row?.job_id);
}

async function job(id: string) {
  const [row] = await admin`select * from public.background_jobs where id = ${id}::uuid`;
  return row as Record<string, unknown>;
}

async function attempts(id: string) {
  return admin`
    select generation, attempt_no, outcome, error_code from public.job_attempts
    where job_id = ${id}::uuid order by generation, attempt_no
  `;
}

/** As if time passed: expired leases and retry delays are due now. */
async function letTimePass(ids: readonly string[]) {
  await admin`
    update public.background_jobs set lease_until = now() - interval '1 second'
    where id = any(string_to_array(${ids.join(",")}, ',')::uuid[]) and status = 'running'
  `;
  await admin`select private.reap_expired_jobs()`;
  await admin`
    update public.background_jobs set available_at = now() - interval '1 second'
    where id = any(string_to_array(${ids.join(",")}, ',')::uuid[]) and status = 'pending'
  `;
}

/** A runner that dies after its processor ran: it never reports anything. */
function crashing(ledger: JobLedger): JobLedger {
  return {
    ...ledger,
    claim: (...args) => ledger.claim(...args),
    heartbeat: (...args) => ledger.heartbeat(...args),
    complete: async () => {
      throw new Error("the process died");
    },
    fail: async () => {
      throw new Error("the process died");
    },
  };
}

describe.runIf(reachable)("D-01 · durable job ledger (real PostgreSQL)", () => {
  const ledgers: PostgresJobLedger[] = [];
  const newLedger = () => {
    const ledger = createPostgresJobLedger({
      url: DB_URL,
      role: "rikuy_worker",
      maxConnections: 3,
    });
    ledgers.push(ledger);
    return ledger;
  };

  beforeAll(async () => {
    await admin`update public.tenants set status = 'active' where id in (${NORTE}::uuid, ${SUR}::uuid)`;
  });

  // Work left by other suites or earlier runs must not be claimed by these tests.
  beforeEach(async () => {
    await admin`
      update public.job_attempts set outcome = 'lease_expired', finished_at = now()
      where outcome = 'running'
    `;
    await admin`
      update public.background_jobs
      set status = 'dead_letter', finished_at = now(), lease_owner = null, lease_until = null,
          last_error_code = 'test_cleanup'
      where status in ('pending', 'running')
    `;
  });

  afterAll(async () => {
    await Promise.all(ledgers.map((ledger) => ledger.close()));
    await admin.end({ timeout: 5 });
  });

  it("never loses an accepted job: crashes, retries and three runners at once", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      ids.push(
        await enqueue(
          i % 2 === 0 ? NORTE : SUR,
          `bulk-${i}`,
          i % 3 === 0 ? { mode: "fail_once" } : {},
        ),
      );
    }

    // A runner takes work and dies before reporting it (it keeps both queue slots busy).
    const dead = crashing(newLedger());
    const crashed = await drainJobs({
      ledger: dead,
      processors: [probe],
      runnerId: `crash-${RUN}`,
      budgetMs: 3_000,
    });
    expect(crashed).toMatchObject({ claimed: 2, unreported: 2 });
    // Until their leases expire, nobody else can run (global concurrency of the queue: 2).
    const blocked = await drainJobs({
      ledger: newLedger(),
      processors: [probe],
      runnerId: `ok1-${RUN}`,
      budgetMs: 1_000,
    });
    expect(blocked.claimed).toBe(0);

    // Later rounds: time passes (leases of the dead runner expire, retries become due).
    for (let round = 0; round < 6; round += 1) {
      const pending = await admin`
        select count(*)::int as n from public.background_jobs
        where id = any(string_to_array(${ids.join(",")}, ',')::uuid[]) and status <> 'succeeded'
      `;
      if (pending[0]?.n === 0) break;
      await letTimePass(ids);
      // Two healthy runners at once.
      await Promise.all([
        drainJobs({
          ledger: newLedger(),
          processors: [probe],
          runnerId: `ok2-${RUN}`,
          budgetMs: 3_000,
          concurrency: 2,
        }),
        drainJobs({
          ledger: newLedger(),
          processors: [probe],
          runnerId: `ok3-${RUN}`,
          budgetMs: 3_000,
          concurrency: 2,
        }),
      ]);
    }

    for (const id of ids) {
      expect((await job(id)).status, id).toBe("succeeded");
      const history = await attempts(id);
      expect(
        history.filter((a) => a.outcome === "succeeded"),
        id,
      ).toHaveLength(1);
      expect(
        history.some((a) => a.outcome === "running"),
        id,
      ).toBe(false);
    }
    const lost = await admin`
      select count(*)::int as n from public.job_attempts a
      where a.job_id = any(string_to_array(${ids.join(",")}, ',')::uuid[]) and a.runner_id = ${`crash-${RUN}`}
        and a.outcome = 'lease_expired'
    `;
    expect(lost[0]?.n).toBe(2);
  });

  it("resumes from the checkpoint of a runner that died, and fences the dead runner off", async () => {
    const id = await enqueue(NORTE, "resume");
    const old = newLedger();
    const [held] = await old.claim(`old-${RUN}`, 1, ["system.probe"]);
    expect(held?.jobId).toBe(id);
    const lease = { jobId: id, fencingToken: (held as ClaimedJob).fencingToken };
    expect(await old.heartbeat(lease, { halfway: true, level: 3 })).toBe("renewed");

    // The old runner goes silent; its lease expires and another runner takes over.
    await letTimePass([id]);
    const fresh = newLedger();
    const [taken] = await fresh.claim(`new-${RUN}`, 1, ["system.probe"]);
    expect(taken).toMatchObject({
      jobId: id,
      attemptNo: 2,
      checkpoint: { halfway: true, level: 3 },
    });
    expect(BigInt((taken as ClaimedJob).fencingToken)).toBeGreaterThan(BigInt(lease.fencingToken));

    // The old runner wakes up: nothing it says is accepted any more.
    expect(await old.heartbeat(lease)).toBe("lease_lost");
    expect(await old.complete(lease, { from: "old" }, { durationMs: 1 })).toBe("lease_lost");
    expect(
      await old.fail(lease, { code: "late", message: "x", retryable: true }, { durationMs: 1 }),
    ).toBe("lease_lost");

    const takenLease = { jobId: id, fencingToken: (taken as ClaimedJob).fencingToken };
    expect(await fresh.complete(takenLease, { from: "new" }, { durationMs: 5 })).toBe("completed");
    expect(await job(id)).toMatchObject({ status: "succeeded", result: { from: "new" } });
    expect((await attempts(id)).map((a) => a.outcome)).toEqual(["lease_expired", "succeeded"]);
  });

  it("creates one job for duplicated enqueues, even at the same time", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => enqueue(SUR, "duplicate", { mode: "ok" })),
    );
    expect(new Set(results).size).toBe(1);
    const [row] = await admin`
      select count(*)::int as n from public.background_jobs where logical_key = ${`${RUN}:duplicate`}
    `;
    expect(row?.n).toBe(1);
  });

  it("sends exhausted jobs to the dead-letter queue, and a replay runs them again", async () => {
    const id = await enqueue(SUR, "exhausted", { mode: "fail_always" });
    const ledger = newLedger();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await drainJobs({ ledger, processors: [probe], runnerId: `dlq-${RUN}`, budgetMs: 2_000 });
      await letTimePass([id]);
    }
    expect(await job(id)).toMatchObject({
      status: "dead_letter",
      attempts: 3,
      last_error_code: "probe_failure",
    });

    // The platform replays it (as the service role here; operators need aal2).
    const [replayed] = await admin.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`;
      return tx`select public.platform_replay_job(${id}::uuid, 1) as generation`;
    });
    expect(replayed?.generation).toBe(2);
    await drainJobs({ ledger, processors: [probe], runnerId: `dlq-${RUN}`, budgetMs: 2_000 });
    const history = await attempts(id);
    expect(history.filter((a) => a.generation === 1)).toHaveLength(3);
    expect(history.filter((a) => a.generation === 2)).toHaveLength(1);
  });

  it("lets tenant B advance while tenant A saturates the queue", async () => {
    const norte: string[] = [];
    for (let i = 0; i < 5; i += 1) norte.push(await enqueue(NORTE, `busy-${i}`, { workMs: 250 }));
    const sur = await enqueue(SUR, "small", { workMs: 50 });

    await Promise.all([
      drainJobs({
        ledger: newLedger(),
        processors: [probe],
        runnerId: `fair1-${RUN}`,
        budgetMs: 8_000,
        concurrency: 2,
      }),
      drainJobs({
        ledger: newLedger(),
        processors: [probe],
        runnerId: `fair2-${RUN}`,
        budgetMs: 8_000,
        concurrency: 2,
      }),
    ]);

    const started = await admin`
      select id, first_started_at, finished_at from public.background_jobs
      where id = any(string_to_array(${[...norte, sur].join(",")}, ',')::uuid[]) order by first_started_at
    `;
    const surRow = started.find((row) => row.id === sur);
    const norteRows = started.filter((row) => row.id !== sur);
    expect(started.every((row) => row.finished_at !== null)).toBe(true);
    // Sur did not wait behind the five jobs of Norte: it finished before Norte's second began.
    expect(new Date(surRow?.finished_at as string).getTime()).toBeLessThanOrEqual(
      new Date(norteRows[1]?.first_started_at as string).getTime(),
    );
    // And Norte never ran two jobs at the same time (one per tenant in this queue).
    for (let i = 1; i < norteRows.length; i += 1) {
      expect(new Date(norteRows[i]?.first_started_at as string).getTime()).toBeGreaterThanOrEqual(
        new Date(norteRows[i - 1]?.finished_at as string).getTime(),
      );
    }
  });

  it("gives the workload role nothing but worker_api", async () => {
    const worker = postgres(DB_URL, {
      max: 1,
      prepare: false,
      connection: { role: "rikuy_worker" },
      onnotice: () => undefined,
    });
    try {
      const denied = async (query: Promise<unknown>) =>
        query.then(
          () => "allowed",
          (error: { code?: string }) => error.code,
        );
      expect(await denied(worker`select * from public.background_jobs limit 1`)).toBe("42501");
      expect(await denied(worker`select * from public.tenants limit 1`)).toBe("42501");
      expect(await denied(worker`select * from public.platform_list_jobs()`)).toBe("42501");
      expect(
        await denied(worker`select private.enqueue_job(${NORTE}::uuid, 'system.probe', 'x')`),
      ).toBe("42501");
      expect(await denied(worker`update public.background_jobs set status = 'succeeded'`)).toBe(
        "42501",
      );
    } finally {
      await worker.end({ timeout: 5 });
    }
  });
});
