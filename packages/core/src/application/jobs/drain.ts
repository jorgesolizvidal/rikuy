import { silentJobLogger, type JobLedger, type JobLogger, type JobProcessor } from "./ports";
import { runClaimedJob, type JobRunReport } from "./run-job";

export interface DrainOptions {
  readonly ledger: JobLedger;
  readonly processors: readonly JobProcessor[];
  /** Identifies this runner in the ledger (e.g. "vercel:gru1:3f9a…"). */
  readonly runnerId: string;
  /** How long this drain may keep claiming new work. */
  readonly budgetMs: number;
  /** Stop claiming when less than this is left (room for the jobs already running). */
  readonly reserveMs?: number;
  /** Jobs run at the same time by this runner. */
  readonly concurrency?: number;
  readonly logger?: JobLogger;
  readonly now?: () => number;
  readonly heartbeatMs?: number;
}

export interface DrainReport {
  readonly claimed: number;
  readonly succeeded: number;
  readonly retried: number;
  readonly deadLettered: number;
  readonly leaseLost: number;
  /** Runs whose outcome could not be reported (the lease will expire and be retried). */
  readonly unreported: number;
  readonly stoppedBecause: "idle" | "budget";
  readonly runs: readonly JobRunReport[];
}

/**
 * Claims and runs jobs until there is no due work or the time budget is spent. Only kinds
 * this runner has processors for are claimed, so a deployment never takes work it cannot do.
 * The database enforces concurrency and fairness; this loop only fills its own slots.
 */
export async function drainJobs(options: DrainOptions): Promise<DrainReport> {
  const now = options.now ?? Date.now;
  const logger = options.logger ?? silentJobLogger;
  const concurrency = Math.min(Math.max(options.concurrency ?? 1, 1), 10);
  const reserveMs = options.reserveMs ?? 0;
  const deadline = now() + options.budgetMs;
  const processors = new Map(options.processors.map((processor) => [processor.kind, processor]));
  const kinds = [...processors.keys()];

  const runs: JobRunReport[] = [];
  let claimed = 0;
  let unreported = 0;
  let stoppedBecause: DrainReport["stoppedBecause"] = "idle";
  const inFlight = new Set<Promise<void>>();

  while (true) {
    if (deadline - now() <= reserveMs) {
      stoppedBecause = "budget";
      break;
    }
    const free = concurrency - inFlight.size;
    if (free === 0) {
      await Promise.race(inFlight);
      continue;
    }
    const jobs =
      kinds.length === 0 ? [] : await options.ledger.claim(options.runnerId, free, kinds);
    claimed += jobs.length;
    for (const job of jobs) {
      const run = runClaimedJob(job, {
        ledger: options.ledger,
        processors,
        logger,
        now,
        ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
      })
        .then((report) => {
          runs.push(report);
        })
        .catch(() => {
          // The ledger could not be told (network). The lease expires and the job is
          // retried: at-least-once, with idempotent processors (ADR-009).
          unreported += 1;
        })
        .finally(() => {
          inFlight.delete(run);
        });
      inFlight.add(run);
    }
    if (jobs.length === 0) {
      if (inFlight.size === 0) break;
      await Promise.race(inFlight);
    }
  }
  await Promise.allSettled(inFlight);

  const count = (outcome: JobRunReport["outcome"]) =>
    runs.filter((run) => run.outcome === outcome).length;
  const summary = {
    claimed,
    succeeded: count("succeeded"),
    retried: count("retry"),
    deadLettered: count("dead_letter"),
    leaseLost: count("lease_lost"),
    unreported,
    stoppedBecause,
  };
  logger.event("drain.finished", { runnerId: options.runnerId, ...summary });
  return { ...summary, runs };
}

/** A runner id the ledger accepts: `prefix:random`, only [A-Za-z0-9._:-]. */
export function newRunnerId(
  prefix: string,
  random: () => string = () => crypto.randomUUID(),
): string {
  const clean = prefix.replace(/[^A-Za-z0-9._:-]/gu, "-").slice(0, 60) || "runner";
  return `${clean}:${random()
    .replace(/[^A-Za-z0-9]/gu, "")
    .slice(0, 32)}`;
}
