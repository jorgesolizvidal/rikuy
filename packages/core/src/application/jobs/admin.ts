import {
  JOB_STATUSES,
  PROBE_MODES,
  type JobAttemptView,
  type JobStatus,
  type PlatformJob,
  type PlatformJobSummary,
  type ProbeMode,
} from "../../contracts/jobs";

export type JobReplayOutcome =
  | { readonly status: "replayed"; readonly generation: number }
  | { readonly status: "stale" }
  | { readonly status: "not_found" }
  | { readonly status: "forbidden" };

export type ProbeOutcome =
  | { readonly status: "enqueued"; readonly jobId: string }
  | { readonly status: "not_found" }
  | { readonly status: "invalid" }
  | { readonly status: "forbidden" };

/** The ledger as a platform operator sees it, with their own session (aal2 in the DB). */
export interface JobAdminRepository {
  summary(): Promise<PlatformJobSummary>;
  list(filter: {
    readonly status: JobStatus | null;
    readonly tenantId: string | null;
  }): Promise<PlatformJob[]>;
  attempts(jobId: string): Promise<JobAttemptView[]>;
  replay(jobId: string, expectedGeneration: number): Promise<JobReplayOutcome>;
  enqueueProbe(tenantId: string, mode: ProbeMode): Promise<ProbeOutcome>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function parseJobStatus(value: unknown): JobStatus | null {
  return typeof value === "string" && (JOB_STATUSES as readonly string[]).includes(value)
    ? (value as JobStatus)
    : null;
}

export interface JobsOverview {
  readonly summary: PlatformJobSummary;
  readonly jobs: readonly PlatformJob[];
  readonly status: JobStatus | null;
}

export async function loadJobsOverview(
  jobs: JobAdminRepository,
  filter: { readonly status?: unknown },
): Promise<JobsOverview> {
  const status = parseJobStatus(filter.status);
  const [summary, list] = await Promise.all([
    jobs.summary(),
    jobs.list({ status, tenantId: null }),
  ]);
  return { summary, jobs: list, status };
}

export async function loadJobAttempts(
  jobs: JobAdminRepository,
  jobId: unknown,
): Promise<JobAttemptView[] | null> {
  if (typeof jobId !== "string" || !UUID.test(jobId)) return null;
  return jobs.attempts(jobId);
}

/** Replay of a dead-letter job: a new generation; the caller names the one it saw. */
export async function replayJob(
  jobs: JobAdminRepository,
  input: { readonly jobId: unknown; readonly generation: unknown },
): Promise<JobReplayOutcome> {
  const generation = Number(input.generation);
  if (typeof input.jobId !== "string" || !UUID.test(input.jobId)) return { status: "not_found" };
  if (!Number.isInteger(generation) || generation < 1) return { status: "stale" };
  return jobs.replay(input.jobId, generation);
}

export async function requestProbe(
  jobs: JobAdminRepository,
  input: { readonly tenantId: unknown; readonly mode: unknown },
): Promise<ProbeOutcome> {
  if (typeof input.tenantId !== "string" || !UUID.test(input.tenantId))
    return { status: "not_found" };
  const mode = input.mode ?? "ok";
  if (typeof mode !== "string" || !(PROBE_MODES as readonly string[]).includes(mode)) {
    return { status: "invalid" };
  }
  return jobs.enqueueProbe(input.tenantId, mode as ProbeMode);
}
