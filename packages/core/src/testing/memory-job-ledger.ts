import type {
  ClaimedJob,
  HeartbeatOutcome,
  JobFailureReport,
  JobLease,
  JobLedger,
  JobMetrics,
} from "../application/jobs/ports";

/**
 * In-memory ledger with the same rules as worker_api (tokens, leases, attempts, retry or
 * dead-letter), for unit tests of runtimes and processors. Retries are due immediately.
 */
export interface MemoryJob {
  readonly jobId: string;
  readonly tenantId: string;
  readonly kind: string;
  payload: unknown;
  schemaVersion: number;
  status: "pending" | "running" | "succeeded" | "dead_letter";
  attempts: number;
  maxAttempts: number;
  generation: number;
  token: number;
  leaseUntil: number;
  checkpoint: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  lastError: JobFailureReport | null;
  metrics: JobMetrics[];
}

export interface MemoryJobLedger extends JobLedger {
  readonly jobs: Map<string, MemoryJob>;
  add(job: Partial<MemoryJob> & { jobId: string; kind: string }): MemoryJob;
  /** Makes a running job's lease expire now (as if its runner stopped renewing it). */
  expire(jobId: string): void;
  readonly calls: { heartbeats: number; completes: number; fails: number };
}

export function createMemoryJobLedger(
  options: {
    leaseSeconds?: number;
    maxActiveSeconds?: number;
    now?: () => number;
  } = {},
): MemoryJobLedger {
  const now = options.now ?? Date.now;
  const leaseSeconds = options.leaseSeconds ?? 60;
  const maxActiveSeconds = options.maxActiveSeconds ?? 120;
  const jobs = new Map<string, MemoryJob>();
  let sequence = 0;
  const calls = { heartbeats: 0, completes: 0, fails: 0 };

  const leased = (lease: JobLease) => {
    const job = jobs.get(lease.jobId);
    return job &&
      job.status === "running" &&
      String(job.token) === lease.fencingToken &&
      job.leaseUntil >= now()
      ? job
      : null;
  };

  return {
    jobs,
    calls,
    add(partial) {
      const job: MemoryJob = {
        tenantId: "t-1",
        payload: {},
        schemaVersion: 1,
        status: "pending",
        attempts: 0,
        maxAttempts: 3,
        generation: 1,
        token: 0,
        leaseUntil: 0,
        checkpoint: null,
        result: null,
        lastError: null,
        metrics: [],
        ...partial,
      };
      jobs.set(job.jobId, job);
      return job;
    },
    expire(jobId) {
      const job = jobs.get(jobId);
      if (job) job.leaseUntil = now() - 1;
    },
    async claim(_runnerId, limit, kinds) {
      await this.reapExpired();
      const claimed: ClaimedJob[] = [];
      for (const job of jobs.values()) {
        if (claimed.length >= limit) break;
        if (job.status !== "pending" || !kinds.includes(job.kind)) continue;
        sequence += 1;
        job.status = "running";
        job.attempts += 1;
        job.token = sequence;
        job.leaseUntil = now() + leaseSeconds * 1_000;
        claimed.push({
          jobId: job.jobId,
          tenantId: job.tenantId,
          kind: job.kind,
          schemaVersion: job.schemaVersion,
          payload: job.payload,
          checkpoint: job.checkpoint,
          generation: job.generation,
          attemptNo: job.attempts,
          fencingToken: String(job.token),
          leaseSeconds,
          maxActiveSeconds,
        });
      }
      return claimed;
    },
    async heartbeat(lease, checkpoint): Promise<HeartbeatOutcome> {
      calls.heartbeats += 1;
      const job = leased(lease);
      if (!job) return "lease_lost";
      job.leaseUntil = now() + leaseSeconds * 1_000;
      if (checkpoint) job.checkpoint = { ...checkpoint };
      return "renewed";
    },
    async complete(lease, result, metrics) {
      calls.completes += 1;
      const job = leased(lease);
      if (!job) return "lease_lost";
      job.status = "succeeded";
      job.result = { ...result };
      job.metrics.push(metrics);
      return "completed";
    },
    async fail(lease, failure, metrics) {
      calls.fails += 1;
      const job = leased(lease);
      if (!job) return "lease_lost";
      job.lastError = failure;
      job.metrics.push(metrics);
      if (failure.retryable && job.attempts < job.maxAttempts) {
        job.status = "pending";
        return "retry";
      }
      job.status = "dead_letter";
      return "dead_letter";
    },
    async reapExpired() {
      let count = 0;
      for (const job of jobs.values()) {
        if (job.status === "running" && job.leaseUntil < now()) {
          job.status = job.attempts >= job.maxAttempts ? "dead_letter" : "pending";
          count += 1;
        }
      }
      return count;
    },
  };
}
