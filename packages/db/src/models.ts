import {
  MODEL_PROBLEMS,
  modelManifestSchema,
  type ModelProblem,
  type ModelRepository,
  type ModelView,
} from "@rikuy/core";
import { z } from "zod";

import type { SessionClient } from "./session-client";

/**
 * The municipality's 3D models with the signed-in user's session (migration
 * 20261025100100): the database checks the role and the tenant.
 */

const rowSchema = z.object({
  version_id: z.uuid(),
  asset_id: z.uuid(),
  version: z.number().int(),
  status: z.enum(["uploading", "processing", "ready", "rejected"]),
  declared_bytes: z.number().int(),
  rejected_reason: z.string().nullable(),
  manifest: z.unknown().nullable(),
  created_at: z.string(),
  ready_at: z.string().nullable(),
  job_status: z.enum(["pending", "running", "succeeded", "dead_letter"]).nullable(),
  job_attempts: z.number().int().nullable(),
  job_max_attempts: z.number().int().nullable(),
  job_last_error_code: z.string().nullable(),
});

export function mapModelRow(raw: unknown): ModelView {
  const row = rowSchema.parse(raw);
  const manifest = row.manifest === null ? null : modelManifestSchema.safeParse(row.manifest);
  return {
    versionId: row.version_id,
    assetId: row.asset_id,
    version: row.version,
    status: row.status,
    declaredBytes: row.declared_bytes,
    problem:
      row.status !== "rejected"
        ? null
        : MODEL_PROBLEMS.includes(row.rejected_reason as ModelProblem)
          ? (row.rejected_reason as ModelProblem)
          : "unreadable",
    manifest: manifest?.success ? manifest.data : null,
    createdAt: row.created_at,
    readyAt: row.ready_at,
    job:
      row.job_status === null
        ? null
        : {
            status: row.job_status,
            attempts: row.job_attempts ?? 0,
            maxAttempts: row.job_max_attempts ?? 0,
            lastErrorCode: row.job_last_error_code,
          },
  };
}

export function createModelRepository(client: SessionClient): ModelRepository {
  return {
    async list(tenantId) {
      const { data, error } = await client.rpc("list_tenant_models", { p_tenant_id: tenantId });
      if (error) throw new Error(`Listing models failed (${error.code || "unknown"})`);
      return z.array(z.unknown()).parse(data).map(mapModelRow);
    },

    async submit(tenantId, versionId) {
      const { data, error } = await client.rpc("submit_model", {
        p_tenant_id: tenantId,
        p_version_id: versionId,
      });
      if (error) {
        if (error.code === "42501") return "forbidden";
        if (error.code === "PT404") return "not_found";
        if (error.code === "PT409") return "not_uploaded";
        throw new Error(`Submitting a model failed (${error.code || "unknown"})`);
      }
      return z.enum(["processing", "ready", "rejected"]).parse(data);
    },

    async setPoster(tenantId, versionId, poster) {
      const { error } = await client.rpc("set_model_poster", {
        p_tenant_id: tenantId,
        p_version_id: versionId,
        p_poster: poster,
      });
      if (!error) return "saved";
      if (error.code === "42501") return "forbidden";
      if (error.code === "PT404") return "not_found";
      if (error.code === "PT409") return "not_ready";
      if (error.code === "23514") return "invalid";
      throw new Error(`Saving a model poster failed (${error.code || "unknown"})`);
    },
  };
}
