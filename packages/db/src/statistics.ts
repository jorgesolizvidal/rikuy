import {
  VISIT_EVENTS,
  VISIT_TARGETS,
  type PassportStatisticsData,
  type StatisticsRepository,
  type VisitStatisticsData,
} from "@rikuy/core";
import { z } from "zod";

import { isMissingFunction } from "./missing-function";

import type { SessionClient } from "./session-client";

/**
 * «Estadísticas» (migration 20261115000000, ADR-052), with the signed-in user's session: the
 * database checks that the person is a member (owners and admins with their second factor).
 */

const count = z.union([z.number(), z.string()]).transform(Number);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

export const statisticsSchema = z.object({
  from: day,
  to: day,
  items: z.array(
    z.object({
      day: day.nullable(),
      target: z.enum(VISIT_TARGETS),
      contentId: z.uuid().nullable(),
      kind: z.enum(["destination", "event"]).nullable(),
      slug: z.string().nullable(),
      title: z.string().nullable(),
      sceneId: z.uuid().nullable(),
      sceneTitle: z.string().nullable(),
      event: z.enum(VISIT_EVENTS),
      views: count,
      visitors: count,
    }),
  ),
  days: z.array(z.object({ day, views: count, visitors: count })),
  origins: z.array(
    z.object({
      day: day.nullable(),
      country: z.string().nullable(),
      city: z.string().nullable(),
      views: count,
      visitors: count,
    }),
  ),
});

/** The tourist passport of a period (migration 20261122000000, ADR-059). */
export const passportStatisticsSchema = z.object({
  from: day,
  to: day,
  since: day.nullable(),
  places: z.array(
    z.object({
      day: day.nullable(),
      contentId: z.uuid(),
      slug: z.string().nullable(),
      title: z.string().nullable(),
      stop: z.boolean(),
      stamps: count,
      located: count,
    }),
  ),
  circuits: z.array(
    z.object({
      day: day.nullable(),
      circuitId: z.uuid(),
      slug: z.string(),
      name: z.string(),
      published: z.boolean(),
      completed: count,
      redeemed: count,
    }),
  ),
});

const calendarSchema = z.array(z.object({ timezone: z.string(), first_day: day.nullable() }));

export function createStatisticsRepository(client: SessionClient): StatisticsRepository {
  return {
    async calendar(tenantId) {
      const { data, error } = await client.rpc("tenant_visit_calendar", { p_tenant_id: tenantId });
      // The web app may be deployed a few minutes before the migration: nothing counted yet.
      if (isMissingFunction(error)) return { timezone: "UTC", firstDay: null };
      if (error)
        throw new Error(`Reading the statistics calendar failed (${error.code || "unknown"})`);
      const row = calendarSchema.parse(data)[0];
      if (!row) throw new Error("Reading the statistics calendar failed (no municipality)");
      return { timezone: row.timezone, firstDay: row.first_day };
    },
    async statistics(tenantId, range, daily): Promise<VisitStatisticsData> {
      const { data, error } = await client.rpc("tenant_visit_statistics", {
        p_tenant_id: tenantId,
        p_from: range.from,
        p_to: range.to,
        p_daily: daily,
      });
      if (isMissingFunction(error)) return { ...range, items: [], days: [], origins: [] };
      if (error) throw new Error(`Reading the statistics failed (${error.code || "unknown"})`);
      return statisticsSchema.parse(data);
    },
    async passport(tenantId, range, daily): Promise<PassportStatisticsData | null> {
      const { data, error } = await client.rpc("tenant_passport_statistics", {
        p_tenant_id: tenantId,
        p_from: range.from,
        p_to: range.to,
        p_daily: daily,
      });
      // The web app may be deployed a few minutes before the migration.
      if (isMissingFunction(error)) return null;
      if (error)
        throw new Error(`Reading the passport statistics failed (${error.code || "unknown"})`);
      return passportStatisticsSchema.parse(data);
    },
  };
}
