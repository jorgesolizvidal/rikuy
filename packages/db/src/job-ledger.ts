import type {
  AbandonedUploadStore,
  ClaimedJob,
  DocumentStore,
  KnowledgeIndexStore,
  HeartbeatOutcome,
  InvitationMailStore,
  JobLedger,
  OperationsReport,
  UnusedMediaStore,
  ModelStore,
  PanoramaStore,
} from "@rikuy/core";
import { operationsReportSchema } from "@rikuy/core";
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
  /** media.process_panorama: worker_api.panorama_source / complete_panorama / reject_panorama. */
  readonly panoramas: PanoramaStore;
  /** media.process_model: worker_api.model_source / complete_model / reject_model. */
  readonly models: ModelStore;
  /** mail.membership_invitation: worker_api.invitation_mail / mark_invitation_mailed. */
  readonly invitations: InvitationMailStore;
  /** media.remove_unused: worker_api.claim_unused_media. */
  readonly unusedMedia: UnusedMediaStore;
  /** media.extract_document: worker_api.document_source / complete_document / reject_document. */
  readonly documents: DocumentStore;
  /** knowledge.index: worker_api.knowledge_source / store_knowledge_chunks. */
  readonly knowledge: KnowledgeIndexStore;
  /** The daily report (worker_api.operations_report): no lease, changes nothing. */
  operationsReport(): Promise<OperationsReport>;
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

    unusedMedia: {
      async claim(lease) {
        try {
          const [row] = await sql`
            select worker_api.claim_unused_media(${lease.jobId}::uuid, ${lease.fencingToken}::bigint) as folder
          `;
          return typeof row?.folder === "string" ? row.folder : null;
        } catch (error) {
          if (leaseLost(error)) return "lease_lost";
          throw error;
        }
      },
    },

    async operationsReport() {
      const [row] = await sql`select worker_api.operations_report() as report`;
      return operationsReportSchema.parse(row?.report);
    },

    invitations: {
      async inspect(lease) {
        try {
          const [row] = await sql`
            select * from worker_api.invitation_mail(${lease.jobId}::uuid, ${lease.fencingToken}::bigint)
          `;
          const state = z.enum(["send", "already_sent", "not_pending"]).parse(row?.state);
          if (state !== "send") return { state };
          return {
            state,
            email: z.string().min(3).parse(row?.email),
            tenantName: z.string().min(1).parse(row?.tenant_name),
            role: z.enum(["owner", "admin", "editor", "analyst"]).parse(row?.role),
            tenantStatus: z.enum(["provisioning", "active"]).parse(row?.tenant_status),
          };
        } catch (error) {
          if (leaseLost(error)) return "lease_lost";
          throw error;
        }
      },
      async markMailed(lease) {
        try {
          const [row] = await sql`
            select worker_api.mark_invitation_mailed(${lease.jobId}::uuid, ${lease.fencingToken}::bigint) as outcome
          `;
          return z.enum(["marked", "already_settled"]).parse(row?.outcome);
        } catch (error) {
          if (leaseLost(error)) return "lease_lost";
          throw error;
        }
      },
    },

    panoramas: {
      async source(lease) {
        try {
          const [row] = await sql`
            select * from worker_api.panorama_source(${lease.jobId}::uuid, ${lease.fencingToken}::bigint)
          `;
          if (!row || row.status === "not_found") return "not_found";
          return {
            status: z.enum(["uploading", "processing", "ready", "rejected"]).parse(row.status),
            originalPath: z.string().parse(row.original_path),
            declaredMime: z.string().parse(row.declared_mime),
            prefix: z.string().parse(row.prefix),
          };
        } catch (error) {
          if (leaseLost(error)) return "lease_lost";
          throw error;
        }
      },
      async complete(lease, metadata, manifest) {
        try {
          const [row] = await sql`
            select worker_api.complete_panorama(
              ${lease.jobId}::uuid, ${lease.fencingToken}::bigint, ${metadata.mime},
              ${metadata.bytes}::integer, ${metadata.width}::integer, ${metadata.height}::integer,
              ${metadata.sha256}, ${json(manifest)}::jsonb
            ) as outcome
          `;
          return z.enum(["ready", "already_settled", "not_found"]).parse(row?.outcome);
        } catch (error) {
          if (leaseLost(error)) return "lease_lost";
          throw error;
        }
      },
      async reject(lease, problem) {
        try {
          const [row] = await sql`
            select worker_api.reject_panorama(
              ${lease.jobId}::uuid, ${lease.fencingToken}::bigint, ${problem}
            ) as outcome
          `;
          return z.enum(["rejected", "already_settled", "not_found"]).parse(row?.outcome);
        } catch (error) {
          if (leaseLost(error)) return "lease_lost";
          throw error;
        }
      },
    },

    models: {
      async source(lease) {
        try {
          const [row] = await sql`
            select * from worker_api.model_source(${lease.jobId}::uuid, ${lease.fencingToken}::bigint)
          `;
          if (!row || row.status === "not_found") return "not_found";
          return {
            status: z.enum(["uploading", "processing", "ready", "rejected"]).parse(row.status),
            originalPath: z.string().parse(row.original_path),
            declaredMime: z.string().parse(row.declared_mime),
            prefix: z.string().parse(row.prefix),
          };
        } catch (error) {
          if (leaseLost(error)) return "lease_lost";
          throw error;
        }
      },
      async complete(lease, original, manifest) {
        try {
          const [row] = await sql`
            select worker_api.complete_model(
              ${lease.jobId}::uuid, ${lease.fencingToken}::bigint, ${original.bytes}::integer,
              ${original.sha256}, ${json(manifest)}::jsonb
            ) as outcome
          `;
          return z.enum(["ready", "already_settled", "not_found"]).parse(row?.outcome);
        } catch (error) {
          if (leaseLost(error)) return "lease_lost";
          throw error;
        }
      },
      async reject(lease, problem) {
        try {
          const [row] = await sql`
            select worker_api.reject_model(
              ${lease.jobId}::uuid, ${lease.fencingToken}::bigint, ${problem}
            ) as outcome
          `;
          return z.enum(["rejected", "already_settled", "not_found"]).parse(row?.outcome);
        } catch (error) {
          if (leaseLost(error)) return "lease_lost";
          throw error;
        }
      },
    },

    documents: {
      async source(lease) {
        try {
          const [row] = await sql`
            select * from worker_api.document_source(${lease.jobId}::uuid, ${lease.fencingToken}::bigint)
          `;
          if (!row || row.status === "not_found") return "not_found";
          return {
            status: z.enum(["uploading", "processing", "ready", "rejected"]).parse(row.status),
            originalPath: z.string().parse(row.original_path),
            declaredMime: z.string().parse(row.declared_mime),
            prefix: z.string().parse(row.prefix),
          };
        } catch (error) {
          if (leaseLost(error)) return "lease_lost";
          throw error;
        }
      },
      async complete(lease, original, manifest) {
        try {
          const [row] = await sql`
            select worker_api.complete_document(
              ${lease.jobId}::uuid, ${lease.fencingToken}::bigint, ${original.mime},
              ${original.bytes}::integer, ${original.sha256}, ${json(manifest)}::jsonb
            ) as outcome
          `;
          return z.enum(["ready", "already_settled", "not_found"]).parse(row?.outcome);
        } catch (error) {
          if (leaseLost(error)) return "lease_lost";
          throw error;
        }
      },
      async reject(lease, problem) {
        try {
          const [row] = await sql`
            select worker_api.reject_document(
              ${lease.jobId}::uuid, ${lease.fencingToken}::bigint, ${problem}
            ) as outcome
          `;
          return z.enum(["rejected", "already_settled", "not_found"]).parse(row?.outcome);
        } catch (error) {
          if (leaseLost(error)) return "lease_lost";
          throw error;
        }
      },
    },

    knowledge: {
      async source(lease) {
        try {
          const [row] = await sql`
            select worker_api.knowledge_source(${lease.jobId}::uuid, ${lease.fencingToken}::bigint) as source
          `;
          return row?.source ?? { status: "not_found" };
        } catch (error) {
          if (leaseLost(error)) return "lease_lost";
          throw error;
        }
      },
      async store(lease, chunkerVersion, title, chunks) {
        try {
          const [row] = await sql`
            select worker_api.store_knowledge_chunks(
              ${lease.jobId}::uuid, ${lease.fencingToken}::bigint, ${chunkerVersion}::integer,
              ${title}, ${json(chunks)}::jsonb
            ) as outcome
          `;
          return z.enum(["stored", "not_found"]).parse(row?.outcome);
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
