/**
 * Durable jobs (ADR-014 contract, ADR-019 runtime). The ledger lives in PostgreSQL and is
 * the source of truth; runtimes (a Vercel function, a CLI, a test) only claim, run and
 * report. Nothing here knows which runtime executes it.
 */

/** A job a runner holds a lease on. */
export interface ClaimedJob {
  readonly jobId: string;
  readonly tenantId: string;
  readonly kind: string;
  readonly schemaVersion: number;
  readonly payload: unknown;
  /** Where a previous attempt left off (null on a first run). */
  readonly checkpoint: Readonly<Record<string, unknown>> | null;
  readonly generation: number;
  readonly attemptNo: number;
  /** Monotonic; every write about this job must carry it (fencing). */
  readonly fencingToken: string;
  readonly leaseSeconds: number;
  /** Product budget of one attempt: past it, the lease is not renewed. */
  readonly maxActiveSeconds: number;
}

export interface JobLease {
  readonly jobId: string;
  readonly fencingToken: string;
}

/** Numbers about one attempt, kept with it (no payloads, no URLs). */
export interface JobMetrics {
  readonly durationMs: number;
  readonly bytesIn?: number;
  readonly bytesOut?: number;
}

export interface JobFailureReport {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
}

export type HeartbeatOutcome = "renewed" | "lease_lost" | "time_budget";

/** The ledger as the workload sees it (worker_api). */
export interface JobLedger {
  claim(runnerId: string, limit: number, kinds: readonly string[]): Promise<ClaimedJob[]>;
  heartbeat(
    lease: JobLease,
    checkpoint?: Readonly<Record<string, unknown>>,
  ): Promise<HeartbeatOutcome>;
  complete(
    lease: JobLease,
    result: Readonly<Record<string, unknown>>,
    metrics: JobMetrics,
  ): Promise<"completed" | "lease_lost">;
  fail(
    lease: JobLease,
    failure: JobFailureReport,
    metrics: JobMetrics,
  ): Promise<"retry" | "dead_letter" | "lease_lost">;
  reapExpired(): Promise<number>;
}

export interface JobContext {
  readonly job: ClaimedJob;
  /** Aborted when the lease is lost or the time budget runs out: stop and return. */
  readonly signal: AbortSignal;
  /** Stores progress to resume from; also renews the lease. Throws when the lease is lost. */
  saveCheckpoint(checkpoint: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface JobProcessorResult {
  readonly result?: Readonly<Record<string, unknown>>;
  readonly bytesIn?: number;
  readonly bytesOut?: number;
}

/** A pure function over use cases; throws `JobFailure` to say whether to retry. */
export interface JobProcessor {
  readonly kind: string;
  readonly schemaVersions: readonly number[];
  run(context: JobContext): Promise<JobProcessorResult>;
}

/** Structured events, never with payloads, checkpoints, signed URLs or tokens. */
export interface JobLogger {
  event(
    name: JobLogEvent,
    fields: Readonly<Record<string, string | number | boolean | null>>,
  ): void;
}

export type JobLogEvent =
  | "job.started"
  | "job.succeeded"
  | "job.retry_scheduled"
  | "job.dead_lettered"
  | "job.lease_lost"
  | "drain.finished";

export const silentJobLogger: JobLogger = { event() {} };
