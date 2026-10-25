import {
  USAGE_RESOURCES,
  type PlatformUsageRepository,
  type PlatformUsageRow,
  type UsageRepository,
  type UsageView,
} from "@rikuy/core";
import { z } from "zod";

import type { SessionClient } from "./session-client";

/**
 * Quotas per municipality (migration 20261025200000), with the signed-in user's session:
 * the database checks membership (reading) and the operator's second factor (changing).
 */

const amount = z.union([z.number(), z.string()]).transform(Number);
const instant = z
  .string()
  .nullable()
  .transform((value) =>
    value === null || /infinity/u.test(value) ? null : new Date(value).toISOString(),
  );

const usageRowSchema = z.object({
  resource: z.enum(USAGE_RESOURCES),
  limit_amount: amount,
  reserved: amount,
  consumed: amount,
  period_start: instant,
  period_end: instant,
});

function mapUsage(raw: unknown): UsageView {
  const row = usageRowSchema.parse(raw);
  return {
    resource: row.resource,
    limit: row.limit_amount,
    reserved: row.reserved,
    consumed: row.consumed,
    periodStart: row.period_start,
    periodEnd: row.period_end,
  };
}

export function createUsageRepository(client: SessionClient): UsageRepository {
  return {
    async tenantUsage(tenantId) {
      const { data, error } = await client.rpc("tenant_usage", { p_tenant_id: tenantId });
      if (error) throw new Error(`Reading usage failed (${error.code || "unknown"})`);
      return z.array(z.unknown()).parse(data).map(mapUsage);
    },
  };
}

const platformRowSchema = z.object({
  tenant_id: z.uuid(),
  slug: z.string(),
  display_name: z.string(),
  resource: z.enum(USAGE_RESOURCES),
  limit_amount: amount,
  is_default: z.boolean(),
  reserved: amount,
  consumed: amount,
});

export function createPlatformUsageRepository(client: SessionClient): PlatformUsageRepository {
  return {
    async list(): Promise<PlatformUsageRow[]> {
      const { data, error } = await client.rpc("platform_tenant_usage");
      if (error) throw new Error(`Reading platform usage failed (${error.code || "unknown"})`);
      return z
        .array(platformRowSchema)
        .parse(data)
        .map((row) => ({
          tenantId: row.tenant_id,
          slug: row.slug,
          displayName: row.display_name,
          resource: row.resource,
          limit: row.limit_amount,
          isDefault: row.is_default,
          reserved: row.reserved,
          consumed: row.consumed,
          periodStart: null,
          periodEnd: null,
        }));
    },

    async setQuota(tenantId, resource, limit) {
      const { error } = await client.rpc("platform_set_quota", {
        p_tenant_id: tenantId,
        p_resource: resource,
        p_limit: limit,
      });
      if (!error) return "changed";
      if (error.code === "42501") return "forbidden";
      if (error.code === "PT404") return "not_found";
      if (error.code === "23514") return "invalid";
      throw new Error(`Changing a quota failed (${error.code || "unknown"})`);
    },
  };
}
