import type {
  ContentActivity,
  MonthlyReportData,
  MonthlyReportRepository,
  MonthlyReportSource,
  MonthlyReportStatus,
  MonthlyReportStore,
  RequestMonthlyReportOutcome,
} from "@rikuy/core";
import { monthStartDate } from "@rikuy/core";
import type postgres from "postgres";
import { z } from "zod";

import { factsSchema, recommendationItemsSchema } from "./copilot-recommendations";
import { parseReviewRows, snapshotSchema } from "./copilot";
import { isMissingFunction } from "./missing-function";
import type { SessionClient } from "./session-client";
import { passportStatisticsSchema, statisticsSchema } from "./statistics";
import { unansweredSchema } from "./unanswered-questions";

/**
 * The monthly report (migration 20261118000000, ADR-055): the panel's reads with the
 * signed-in user's session, and the job's store (worker_api, the workload's connection,
 * always under the job's lease). Every number comes from the same functions as «Estadísticas».
 */

const count = z.union([z.number(), z.string()]).transform(Number);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

const activitySchema = z.object({
  from: day,
  to: day,
  total: count,
  items: z.array(
    z.object({
      contentId: z.uuid(),
      kind: z.enum(["destination", "event", "knowledge"]),
      title: z.string(),
      tour: z.boolean(),
      times: count,
      first: z.boolean(),
      publishedAt: z.string(),
    }),
  ),
});

const savedSchema = z
  .object({
    generatedAt: z.string(),
    from: day,
    to: day,
    facts: factsSchema.nullable(),
    items: recommendationItemsSchema.nullable(),
    note: z.string().nullable(),
    forgotten: z.boolean(),
    mailedAt: z.string().nullable(),
    mailedCount: z.number().int().nullable(),
  })
  .nullable();

const statusSchema = z.object({
  from: day,
  to: day,
  today: day,
  firstDay: day.nullable(),
  report: savedSchema,
  pending: z.boolean(),
  requestsToday: count,
});

export function parseContentActivity(data: unknown): ContentActivity {
  return activitySchema.parse(data);
}

export function createMonthlyReportRepository(client: SessionClient): MonthlyReportRepository {
  return {
    async status(tenantId, month): Promise<MonthlyReportStatus> {
      const { data, error } = await client.rpc("tenant_monthly_report", {
        p_tenant_id: tenantId,
        p_month: monthStartDate(month),
      });
      // The web app may be deployed a few minutes before the migration: nothing saved yet.
      if (isMissingFunction(error)) {
        const today = new Date().toISOString().slice(0, 10);
        return {
          from: monthStartDate(month),
          to: today,
          today,
          firstDay: null,
          report: null,
          pending: false,
          requestsToday: 0,
        };
      }
      if (error) throw new Error(`Reading the monthly report failed (${error.code || "unknown"})`);
      return statusSchema.parse(data);
    },

    async questions(tenantId, range) {
      const { data, error } = await client.rpc("tenant_unanswered_questions_between", {
        p_tenant_id: tenantId,
        p_from: range.from,
        p_to: range.to,
      });
      if (isMissingFunction(error)) {
        return { ...range, since: null, total: 0, people: 0, groups: [] };
      }
      if (error)
        throw new Error(`Reading the unanswered questions failed (${error.code || "unknown"})`);
      return unansweredSchema.parse(data);
    },

    async activity(tenantId, range) {
      const { data, error } = await client.rpc("tenant_content_activity", {
        p_tenant_id: tenantId,
        p_from: range.from,
        p_to: range.to,
      });
      if (isMissingFunction(error)) return { ...range, total: 0, items: [] };
      if (error) throw new Error(`Reading what was published failed (${error.code || "unknown"})`);
      return parseContentActivity(data);
    },

    async request(tenantId, month): Promise<RequestMonthlyReportOutcome> {
      const { error, status } = await client.rpc("request_monthly_report", {
        p_tenant_id: tenantId,
        p_month: monthStartDate(month),
      });
      if (!error) return "queued";
      if (isMissingFunction(error)) return "invalid";
      if (error.code === "42501" || status === 403) return "forbidden";
      if (error.code === "PT429") return "too_many";
      if (error.code === "PT409") return "not_online";
      if (error.code === "22023") return "invalid";
      throw new Error(`Asking for the monthly report failed (${error.code || "unknown"})`);
    },
  };
}

// ── The job's store (worker_api) ────────────────────────────────────────────

const sourceSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("run"),
    tenantId: z.uuid(),
    name: z.string().min(1),
    slug: z.string().min(1),
    timezone: z.string().min(1),
    month: day,
    from: day,
    to: day,
    today: day,
    firstDay: day.nullable(),
    manual: z.boolean(),
    recipients: z.array(z.string().min(3)),
    generated: z.boolean(),
    items: recommendationItemsSchema.nullable().optional(),
    note: z.string().nullable().optional(),
    mailed: z.boolean(),
  }),
  z.object({ state: z.literal("skip"), reason: z.enum(["not_online", "invalid_month"]) }),
]);

const dataSchema = z.object({
  current: statisticsSchema,
  previous: statisticsSchema.nullable(),
  questions: unansweredSchema,
  review: z.unknown(),
  snapshot: snapshotSchema,
  activity: activitySchema,
  // Absent before migration 20261122000000 (the worker may run a few minutes earlier).
  passport: passportStatisticsSchema.nullable().optional(),
  passportPrevious: passportStatisticsSchema.nullable().optional(),
});

/** worker_api's monthly report functions over the workload's connection. */
export function createPostgresMonthlyReportStore(
  sql: postgres.Sql,
  leaseLost: (error: unknown) => boolean,
): MonthlyReportStore {
  const json = (value: unknown) => sql.json(value as Parameters<typeof sql.json>[0]);
  const guarded = async <T>(work: () => Promise<T>): Promise<T | "lease_lost"> => {
    try {
      return await work();
    } catch (error) {
      if (leaseLost(error)) return "lease_lost";
      throw error;
    }
  };
  return {
    source: (lease) =>
      guarded(async (): Promise<MonthlyReportSource> => {
        const [row] = await sql`
          select worker_api.monthly_report_source(${lease.jobId}::uuid, ${lease.fencingToken}::bigint) as source
        `;
        const parsed = sourceSchema.parse(row?.source);
        if (parsed.state === "skip") return parsed;
        return { ...parsed, items: parsed.items ?? null, note: parsed.note ?? null };
      }),

    data: (lease, range, previous) =>
      guarded(async (): Promise<MonthlyReportData> => {
        const [row] = await sql`
          select worker_api.monthly_report_data(
            ${lease.jobId}::uuid, ${lease.fencingToken}::bigint,
            ${range.from}::date, ${range.to}::date,
            ${previous?.from ?? null}::date, ${previous?.to ?? null}::date
          ) as data
        `;
        const parsed = dataSchema.parse(row?.data);
        return {
          ...parsed,
          review: parseReviewRows(parsed.review),
          passport: parsed.passport ?? null,
          passportPrevious: parsed.passportPrevious ?? null,
        };
      }),

    save: (lease, input) =>
      guarded(async () => {
        await sql`
          select worker_api.save_monthly_report(
            ${lease.jobId}::uuid, ${lease.fencingToken}::bigint, ${input.to}::date,
            ${input.aiRequestId}::uuid,
            ${input.facts === null ? null : json(input.facts)}::jsonb,
            ${input.items === null ? null : json(input.items)}::jsonb,
            ${input.note}
          )
        `;
        return "saved" as const;
      }),

    markMailed: (lease, count) =>
      guarded(async () => {
        const [row] = await sql`
          select worker_api.mark_monthly_report_mailed(
            ${lease.jobId}::uuid, ${lease.fencingToken}::bigint, ${count}::integer
          ) as outcome
        `;
        return z.enum(["marked", "already_mailed", "missing"]).parse(row?.outcome);
      }),
  };
}
