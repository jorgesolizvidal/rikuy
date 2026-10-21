import {
  permanentFailure,
  safeJobMessage,
  toJobFailure,
  transientFailure,
} from "../../domain/jobs/failure";
import {
  silentJobLogger,
  type ClaimedJob,
  type HeartbeatOutcome,
  type JobLedger,
  type JobLogger,
  type JobMetrics,
  type JobProcessor,
} from "./ports";

export interface RunJobDeps {
  readonly ledger: JobLedger;
  readonly processors: ReadonlyMap<string, JobProcessor>;
  readonly logger?: JobLogger;
  readonly now?: () => number;
  /** Heartbeat interval; by default a quarter of the lease (at least 1 s). */
  readonly heartbeatMs?: number;
}

export type JobRunOutcome = "succeeded" | "retry" | "dead_letter" | "lease_lost";

export interface JobRunReport {
  readonly jobId: string;
  readonly tenantId: string;
  readonly kind: string;
  readonly outcome: JobRunOutcome;
  readonly durationMs: number;
  readonly errorCode: string | null;
}

/** Why a running attempt was stopped from outside the processor. */
class JobHalt extends Error {
  constructor(readonly reason: Exclude<HeartbeatOutcome, "renewed">) {
    super(reason);
    this.name = "JobHalt";
  }
}

/**
 * Runs one claimed job: keeps its lease alive while the processor works, stops it when the
 * lease is lost or its time budget runs out, and reports the outcome to the ledger.
 *
 * - Success → `complete` (accepted only with the current fencing token).
 * - `JobFailure` → `fail`: the ledger retries transient ones and dead-letters the rest.
 * - Lease lost → nothing is written: another runner owns the job now (fencing).
 * - Time budget → reported as a transient failure while the lease is still ours.
 */
export async function runClaimedJob(job: ClaimedJob, deps: RunJobDeps): Promise<JobRunReport> {
  const now = deps.now ?? Date.now;
  const logger = deps.logger ?? silentJobLogger;
  const started = now();
  const lease = { jobId: job.jobId, fencingToken: job.fencingToken };
  const base = {
    jobId: job.jobId,
    tenantId: job.tenantId,
    kind: job.kind,
    generation: job.generation,
    attempt: job.attemptNo,
  };
  const report = (outcome: JobRunOutcome, errorCode: string | null): JobRunReport => ({
    jobId: job.jobId,
    tenantId: job.tenantId,
    kind: job.kind,
    outcome,
    durationMs: now() - started,
    errorCode,
  });

  const controller = new AbortController();
  let halted: JobHalt | null = null;
  const halt = (reason: JobHalt["reason"]) => {
    if (halted) return;
    halted = new JobHalt(reason);
    controller.abort(halted);
  };
  const beat = async (checkpoint?: Readonly<Record<string, unknown>>) => {
    const outcome = await deps.ledger.heartbeat(lease, checkpoint);
    if (outcome !== "renewed") halt(outcome);
    return outcome;
  };

  const interval = deps.heartbeatMs ?? Math.max(1_000, (job.leaseSeconds * 1_000) / 4);
  const heartbeat = setInterval(() => {
    // A failed heartbeat (network) is not fatal: the next one tries again, and if the
    // lease expires meanwhile the ledger answers "lease lost".
    if (!halted) beat().catch(() => undefined);
  }, interval);
  const budget = setTimeout(() => halt("time_budget"), job.maxActiveSeconds * 1_000);
  const stopTimers = () => {
    clearInterval(heartbeat);
    clearTimeout(budget);
  };

  logger.event("job.started", base);
  let bytes: { bytesIn?: number | undefined; bytesOut?: number | undefined } = {};
  let result: Readonly<Record<string, unknown>> = {};
  let failure: ReturnType<typeof toJobFailure> | null = null;
  try {
    const processor = deps.processors.get(job.kind);
    if (!processor) throw permanentFailure("no_processor", `No processor for ${job.kind}.`);
    if (!processor.schemaVersions.includes(job.schemaVersion)) {
      throw permanentFailure(
        "unsupported_schema_version",
        `${job.kind} does not support payload version ${job.schemaVersion}.`,
      );
    }

    const stopped = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
        once: true,
      });
    });
    stopped.catch(() => undefined);

    const output = await Promise.race([
      processor.run({
        job,
        signal: controller.signal,
        async saveCheckpoint(checkpoint) {
          const outcome = await beat(checkpoint);
          if (outcome !== "renewed") throw new JobHalt(outcome);
        },
      }),
      stopped,
    ]);
    if (halted) throw halted;
    bytes = { bytesIn: output.bytesIn, bytesOut: output.bytesOut };
    result = output.result ?? {};
  } catch (error) {
    const reason =
      (halted as JobHalt | null)?.reason ?? (error instanceof JobHalt ? error.reason : null);
    failure =
      reason === "lease_lost"
        ? null
        : reason === "time_budget"
          ? transientFailure(
              "time_budget_exceeded",
              `The attempt ran past its budget of ${job.maxActiveSeconds} s.`,
            )
          : toJobFailure(error);
    if (reason === "lease_lost") {
      stopTimers();
      logger.event("job.lease_lost", { ...base, durationMs: now() - started });
      return report("lease_lost", "lease_lost");
    }
  } finally {
    stopTimers();
  }

  // Reporting is outside the processor's failure handling: if the ledger cannot be told
  // (network), the error propagates, nothing is assumed, and the lease simply expires.
  if (failure === null) {
    const completed = await deps.ledger.complete(lease, result, metrics());
    if (completed === "lease_lost") {
      logger.event("job.lease_lost", { ...base, durationMs: now() - started });
      return report("lease_lost", "lease_lost");
    }
    logger.event("job.succeeded", { ...base, durationMs: now() - started });
    return report("succeeded", null);
  }

  const failed = await deps.ledger.fail(
    lease,
    {
      code: failure.code,
      message: safeJobMessage(failure.message),
      retryable: failure.retryable,
      ...(failure.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: failure.retryAfterSeconds }),
    },
    metrics(),
  );
  if (failed === "lease_lost") {
    logger.event("job.lease_lost", { ...base, durationMs: now() - started });
    return report("lease_lost", "lease_lost");
  }
  logger.event(failed === "retry" ? "job.retry_scheduled" : "job.dead_lettered", {
    ...base,
    durationMs: now() - started,
    errorCode: failure.code,
  });
  return report(failed, failure.code);

  function metrics(): JobMetrics {
    return {
      durationMs: now() - started,
      ...(bytes.bytesIn === undefined ? {} : { bytesIn: bytes.bytesIn }),
      ...(bytes.bytesOut === undefined ? {} : { bytesOut: bytes.bytesOut }),
    };
  }
}
