import type { AbandonedUploadStore, ClaimedJob, HeartbeatOutcome, JobLedger } from "@rikuy/core";
import postgres from "postgres";
import { z } from "zod";

/**
 * Durable job ledger, WORKLOAD side (migrations 20261020000000 and 20261024000000): a direct PostgreSQL
 * connection (through the Supabase pooler in the cloud) as the dedicated role
 * rikuy_worker, which can only execute worker_api functions. Never the service role,
 * never a user's session. Imported only from "@rikuy/db/worker".
 */

export interface PostgresJobLedgerOptions {
  /** postgres://… of the worker role (pooler in transaction mode is fine). */
  readonly url: string;
  /**
   * Act as this role after connecting. Only for local development and tests, where the
   * connection is made as `postgres`; in the cloud the URL's user already is the worker.
   */
  readonly role?: string;
  readonly maxConnections?: number;
}

export interface PostgresJobLedger extends JobLedger {
  /** media.expire_abandoned_upload: worker_api.abandoned_upload / mark_upload_abandoned. */
  readonly uploads: AbandonedUploadStore;
  close(): Promise<void>;
}

const claimedRowSchema = z.object({
  job_id: z.uuid(),
  tenant_id: z.uuid(),
  kind: z.string(),
  schema_version: z.number().int(),
  payload: z.unknown(),
  checkpoint: z.record(z.string(), z.unknown()).nullable(),
  generation: z.number().int(),
  attempt_no: z.number().int(),
  fencing_token: z.union([z.string(), z.number(), z.bigint()]).transform(String),
  lease_seconds: z.number().int(),
  max_active_seconds: z.number().int(),
});

function sqlCode(error: unknown): { code: string; hint: string } {
  const value = error as { code?: unknown; hint?: unknown } | null;
  return {
    code: typeof value?.code === "string" ? value.code : "",
    hint: typeof value?.hint === "string" ? value.hint : "",
  };
}

const leaseLost = (error: unknown) => {
  const { code, hint } = sqlCode(error);
  return code === "PT409" && hint === "lease";
};

export function createPostgresJobLedger(options: PostgresJobLedgerOptions): PostgresJobLedger {
  // Encrypted to anything but a local database (the Supabase pooler accepts TLS).
  const host = new URL(options.url.replace(/^postgres(ql)?:/u, "http:")).hostname;
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "";
  const sql = postgres(options.url, {
    ssl: local ? false : "require",
    max: options.maxConnections ?? 4,
    // The Supabase pooler (transaction mode) does not keep prepared statements.
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    ...(options.role ? { connection: { role: options.role } } : {}),
    // Notices from the database are not logged (they could echo values).
    onnotice: () => undefined,
  });
  const json = (value: unknown) => sql.json(value as Parameters<typeof sql.json>[0]);

  return {
    async claim(runnerId, limit, kinds): Promise<ClaimedJob[]> {
      // Kind names are [a-z0-9_.] only (checked by the ledger): a comma list is unambiguous.
      if (kinds.length === 0) return [];
      const rows = await sql`
        select * from worker_api.claim_jobs(
          ${runnerId}, ${limit}, string_to_array(${kinds.join(",")}, ',')
        )
      `;
      return rows.map((raw) => {
        const row = claimedRowSchema.parse(raw);
        return {
          jobId: row.job_id,
          tenantId: row.tenant_id,
          kind: row.kind,
          schemaVersion: row.schema_version,
          payload: row.payload,
          checkpoint: row.checkpoint,
          generation: row.generation,
          attemptNo: row.attempt_no,
          fencingToken: row.fencing_token,
          leaseSeconds: row.lease_seconds,
          maxActiveSeconds: row.max_active_seconds,
        };
      });
    },

    async heartbeat(lease, checkpoint): Promise<HeartbeatOutcome> {
      try {
        await sql`
          select worker_api.heartbeat(
            ${lease.jobId}::uuid, ${lease.fencingToken}::bigint,
            ${checkpoint === undefined ? null : json(checkpoint)}::jsonb
          )
        `;
        return "renewed";
      } catch (error) {
        if (leaseLost(error)) return "lease_lost";
        if (sqlCode(error).code === "PT408") return "time_budget";
        throw error;
      }
    },

    async complete(lease, result, metrics) {
      try {
        await sql`
          select worker_api.complete_job(
            ${lease.jobId}::uuid, ${lease.fencingToken}::bigint, ${json(result)}::jsonb,
            ${json(metrics)}::jsonb
          )
        `;
        return "completed";
      } catch (error) {
        if (leaseLost(error)) return "lease_lost";
        throw error;
      }
    },

    async fail(lease, failure, metrics) {
      try {
        const [row] = await sql`
          select worker_api.fail_job(
            ${lease.jobId}::uuid, ${lease.fencingToken}::bigint, ${failure.code}, ${failure.message},
            ${failure.retryable}, ${failure.retryAfterSeconds ?? null}::integer, ${json(metrics)}::jsonb
          ) as status
        `;
        return row?.status === "pending" ? "retry" : "dead_letter";
      } catch (error) {
        if (leaseLost(error)) return "lease_lost";
        throw error;
      }
    },

    async reapExpired() {
      const [row] = await sql`select worker_api.reap_expired_jobs() as count`;
      return Number(row?.count ?? 0);
    },

    uploads: {
      async inspect(lease) {
        try {
          const [row] = await sql`
            select * from worker_api.abandoned_upload(${lease.jobId}::uuid, ${lease.fencingToken}::bigint)
          `;
          return {
            abandoned: row?.abandoned === true,
            originalPath: typeof row?.original_path === "string" ? row.original_path : null,
          };
        } catch (error) {
          if (leaseLost(error)) return "lease_lost";
          throw error;
        }
      },
      async markAbandoned(lease) {
        try {
          const [row] = await sql`
            select worker_api.mark_upload_abandoned(${lease.jobId}::uuid, ${lease.fencingToken}::bigint) as outcome
          `;
          return z.enum(["marked", "already_settled", "not_found"]).parse(row?.outcome);
        } catch (error) {
          if (leaseLost(error)) return "lease_lost";
          throw error;
        }
      },
    },

    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}
