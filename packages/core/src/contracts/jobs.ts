import { z } from "zod";

/** Kinds of durable jobs. Each one is registered in the ledger (public.job_kinds). */
export const JOB_KINDS = {
  /** «Probar el ejecutor»: changes nothing, leaves a record that it ran. */
  probe: "system.probe",
} as const;

export type JobKind = (typeof JOB_KINDS)[keyof typeof JOB_KINDS];

export const PROBE_MODES = ["ok", "fail_once", "fail_always"] as const;
export type ProbeMode = (typeof PROBE_MODES)[number];

/** Same shape the database accepts (private.is_valid_job_payload). */
export const probePayloadSchema = z
  .object({
    mode: z.enum(PROBE_MODES).default("ok"),
    workMs: z.number().int().min(0).max(10_000).default(0),
  })
  .strict();

export type JobStatus = "pending" | "running" | "succeeded" | "dead_letter";
export type JobAttemptOutcome = "running" | "succeeded" | "retry" | "failed" | "lease_expired";

export const JOB_STATUSES: readonly JobStatus[] = [
  "pending",
  "running",
  "succeeded",
  "dead_letter",
];

/** What a platform operator sees of a job: state, never payloads or results. */
export interface PlatformJob {
  readonly jobId: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly kind: string;
  readonly kindDescription: string;
  readonly status: JobStatus;
  readonly generation: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly availableAt: string;
  readonly createdAt: string;
  readonly firstStartedAt: string | null;
  readonly finishedAt: string | null;
  readonly leaseUntil: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
}

export interface PlatformJobSummary {
  readonly pending: number;
  /** Pending and already due: waiting only for a runner. */
  readonly due: number;
  readonly running: number;
  readonly deadLetter: number;
  readonly succeededLastDay: number;
  readonly oldestDueAt: string | null;
  /** The database's clock when the summary was read. */
  readonly checkedAt: string;
}

export interface JobAttemptView {
  readonly generation: number;
  readonly attemptNo: number;
  readonly runnerId: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly outcome: JobAttemptOutcome;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly durationMs: number | null;
}
