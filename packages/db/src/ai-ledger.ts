import type { AiBeginOutcome, AiLedger } from "@rikuy/core";
import postgres from "postgres";
import { z } from "zod";

/**
 * The AI gateway's ledger (migration 20261101000100, ADR-036): a direct PostgreSQL
 * connection (through the Supabase pooler in the cloud) as the dedicated role rikuy_ai,
 * which can only execute ai_api functions. Never the service role, never a user's session.
 * Imported only from "@rikuy/db/ai".
 */

export interface PostgresAiLedgerOptions {
  /** postgres://… of the AI role (pooler in transaction mode is fine). */
  readonly url: string;
  /**
   * Act as this role after connecting. Only for local development and tests, where the
   * connection is made as `postgres`; in the cloud the URL's user already is rikuy_ai.
   */
  readonly role?: string;
  readonly maxConnections?: number;
}

export interface PostgresAiLedger extends AiLedger {
  close(): Promise<void>;
}

const beginRowSchema = z.object({
  request_id: z.uuid(),
  outcome: z.enum([
    "reserved",
    "tenant_quota",
    "platform_quota",
    "visitor_limit",
    "tenant_unavailable",
  ]),
});

export function createPostgresAiLedger(options: PostgresAiLedgerOptions): PostgresAiLedger {
  // Encrypted to anything but a local database (the Supabase pooler accepts TLS).
  const host = new URL(options.url.replace(/^postgres(ql)?:/u, "http:")).hostname;
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "";
  const sql = postgres(options.url, {
    ssl: local ? false : "require",
    max: options.maxConnections ?? 2,
    // The Supabase pooler (transaction mode) does not keep prepared statements.
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 5,
    ...(options.role ? { connection: { role: options.role } } : {}),
    // Notices from the database are not logged (they could echo values).
    onnotice: () => undefined,
  });

  return {
    async begin(input) {
      const rows = await sql`
        select * from ai_api.begin_request(
          ${input.tenantId}::uuid, ${input.profile}, ${input.reserveTokens}::bigint,
          ${input.visitor}::text, ${input.actorId}::uuid
        )
      `;
      const row = beginRowSchema.parse(rows[0]);
      return { requestId: row.request_id, outcome: row.outcome satisfies AiBeginOutcome };
    },

    async finish(requestId, outcome, executions) {
      await sql`
        select ai_api.finish_request(
          ${requestId}::uuid, ${outcome},
          ${sql.json(executions.map((execution) => ({ ...execution })))}::jsonb
        )
      `;
    },

    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}
