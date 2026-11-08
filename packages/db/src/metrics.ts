import {
  ERROR_SURFACES,
  metricsOverviewSchema,
  tenantMetricsSchema,
  type MetricsRepository,
  type RequestErrorRow,
} from "@rikuy/core";
import { z } from "zod";

import { failure, unexpected } from "./content";
import type { SessionClient } from "./session-client";

/**
 * The operator's metric readings (ADR-044), with the operator's own session: every RPC
 * checks the second factor again. The tables are never read directly.
 */

const errorRowSchema = z.object({
  id: z.uuid(),
  occurred_at: z.string(),
  surface: z.enum(ERROR_SURFACES),
  route: z.string(),
  method: z.string(),
  kind: z.string(),
  message: z.string(),
  request_id: z.uuid(),
  digest: z.string().nullable(),
});

export function createMetricsRepository(client: SessionClient): MetricsRepository {
  return {
    async overview() {
      const { data, error } = await client.rpc("platform_metrics_overview");
      if (error) throw unexpected("Reading the metrics overview", error);
      return metricsOverviewSchema.parse(data);
    },

    async tenant(tenantId) {
      const { data, error, status } = await client.rpc("platform_tenant_metrics", {
        p_tenant_id: tenantId,
      });
      if (error) {
        if (failure(error, status) === "not_found") return null;
        throw unexpected("Reading a municipality's metrics", error);
      }
      return tenantMetricsSchema.parse(data);
    },

    async errors(tenantId, search): Promise<RequestErrorRow[]> {
      const { data, error } = await client.rpc("platform_tenant_errors", {
        p_tenant_id: tenantId,
        p_search: search,
        p_limit: 50,
      });
      if (error) throw unexpected("Reading errors", error);
      return z
        .array(errorRowSchema)
        .parse(data)
        .map((row) => ({
          id: row.id,
          occurredAt: row.occurred_at,
          surface: row.surface,
          route: row.route,
          method: row.method,
          kind: row.kind,
          message: row.message,
          requestId: row.request_id,
          digest: row.digest,
        }));
    },

    async checkPublication(tenantId) {
      const { error, status } = await client.rpc("platform_check_publication", {
        p_tenant_id: tenantId,
      });
      if (!error) return "checked";
      const outcome = failure(error, status);
      if (outcome === "not_found" || outcome === "forbidden") return outcome;
      throw unexpected("Checking what is published", error);
    },
  };
}
