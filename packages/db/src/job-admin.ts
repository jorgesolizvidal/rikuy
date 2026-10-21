import type { PostgrestError } from "@supabase/supabase-js";
import type {
  JobAdminRepository,
  JobAttemptView,
  JobReplayOutcome,
  PlatformJob,
  PlatformJobSummary,
  ProbeOutcome,
} from "@rikuy/core";
import { z } from "zod";

import type { SessionClient } from "./session-client";

/**
 * The durable job ledger as a platform operator sees it (migration 20261020000000), with
 * their own session: the database requires an active operator with a second factor, and
 * returns state only (no payloads, checkpoints or results).
 */

const statusSchema = z.enum(["pending", "running", "succeeded", "dead_letter"]);
const count = z.union([z.number(), z.string()]).transform(Number);

const summarySchema = z.object({
  pending: count,
  due: count,
  running: count,
  dead_letter: count,
  succeeded_last_day: count,
  oldest_due_at: z.string().nullable(),
  checked_at: z.string(),
});

const jobRowSchema = z.object({
  job_id: z.uuid(),
  tenant_id: z.uuid(),
  tenant_name: z.string(),
  kind: z.string(),
  kind_description: z.string(),
  status: statusSchema,
  generation: z.number().int(),
  attempts: z.number().int(),
  max_attempts: z.number().int(),
  available_at: z.string(),
  created_at: z.string(),
  first_started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  lease_until: z.string().nullable(),
  last_error_code: z.string().nullable(),
  last_error_message: z.string().nullable(),
});

const attemptRowSchema = z.object({
  generation: z.number().int(),
  attempt_no: z.number().int(),
  runner_id: z.string(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  outcome: z.enum(["running", "succeeded", "retry", "failed", "lease_expired"]),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  duration_ms: z.number().int().nullable(),
});

function unexpected(operation: string, error: PostgrestError): Error {
  return new Error(`${operation} failed (${error.code || "unknown"})`);
}

export function createJobAdminRepository(client: SessionClient): JobAdminRepository {
  return {
    async summary(): Promise<PlatformJobSummary> {
      const { data, error } = await client.rpc("platform_job_summary");
      if (error) throw unexpected("Reading the job summary", error);
      const row = summarySchema.parse(Array.isArray(data) ? data[0] : data);
      return {
        pending: row.pending,
        due: row.due,
        running: row.running,
        deadLetter: row.dead_letter,
        succeededLastDay: row.succeeded_last_day,
        oldestDueAt: row.oldest_due_at,
        checkedAt: row.checked_at,
      };
    },

    async list(filter): Promise<PlatformJob[]> {
      const { data, error } = await client.rpc("platform_list_jobs", {
        p_status: filter.status,
        p_tenant_id: filter.tenantId,
        p_limit: 200,
      });
      if (error) throw unexpected("Listing jobs", error);
      return z
        .array(jobRowSchema)
        .parse(data)
        .map((row) => ({
          jobId: row.job_id,
          tenantId: row.tenant_id,
          tenantName: row.tenant_name,
          kind: row.kind,
          kindDescription: row.kind_description,
          status: row.status,
          generation: row.generation,
          attempts: row.attempts,
          maxAttempts: row.max_attempts,
          availableAt: row.available_at,
          createdAt: row.created_at,
          firstStartedAt: row.first_started_at,
          finishedAt: row.finished_at,
          leaseUntil: row.lease_until,
          lastErrorCode: row.last_error_code,
          lastErrorMessage: row.last_error_message,
        }));
    },

    async attempts(jobId): Promise<JobAttemptView[]> {
      const { data, error } = await client.rpc("platform_job_attempts", { p_job_id: jobId });
      if (error) throw unexpected("Listing job attempts", error);
      return z
        .array(attemptRowSchema)
        .parse(data)
        .map((row) => ({
          generation: row.generation,
          attemptNo: row.attempt_no,
          runnerId: row.runner_id,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          outcome: row.outcome,
          errorCode: row.error_code,
          errorMessage: row.error_message,
          durationMs: row.duration_ms,
        }));
    },

    async replay(jobId, expectedGeneration): Promise<JobReplayOutcome> {
      const { data, error } = await client.rpc("platform_replay_job", {
        p_job_id: jobId,
        p_expected_generation: expectedGeneration,
      });
      if (error) {
        if (error.code === "42501") return { status: "forbidden" };
        if (error.code === "PT404") return { status: "not_found" };
        if (error.code === "PT409") return { status: "stale" };
        throw unexpected("Replaying a job", error);
      }
      return { status: "replayed", generation: z.number().int().parse(data) };
    },

    async enqueueProbe(tenantId, mode): Promise<ProbeOutcome> {
      const { data, error } = await client.rpc("platform_enqueue_probe", {
        p_tenant_id: tenantId,
        p_mode: mode,
      });
      if (error) {
        if (error.code === "42501") return { status: "forbidden" };
        if (error.code === "PT404") return { status: "not_found" };
        if (error.code === "23514") return { status: "invalid" };
        throw unexpected("Requesting a probe", error);
      }
      return { status: "enqueued", jobId: z.uuid().parse(data) };
    },
  };
}
