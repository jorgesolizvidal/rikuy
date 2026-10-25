import {
  panoramaManifestSchema,
  type PanoramaProblem,
  type PanoramaRepository,
  type PanoramaView,
} from "@rikuy/core";
import { z } from "zod";

import type { SessionClient } from "./session-client";

/**
 * The municipality's panoramas with the signed-in user's session (migration
 * 20261025000100): the database checks the role and the tenant.
 */

const PROBLEMS: readonly PanoramaProblem[] = [
  "unsupported_type",
  "too_heavy",
  "type_mismatch",
  "too_small",
  "too_large",
  "unreadable",
  "not_equirectangular",
];

const rowSchema = z.object({
  version_id: z.uuid(),
  asset_id: z.uuid(),
  version: z.number().int(),
  status: z.enum(["uploading", "processing", "ready", "rejected"]),
  declared_bytes: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  rejected_reason: z.string().nullable(),
  manifest: z.unknown().nullable(),
  created_at: z.string(),
  ready_at: z.string().nullable(),
  job_status: z.enum(["pending", "running", "succeeded", "dead_letter"]).nullable(),
  job_attempts: z.number().int().nullable(),
  job_max_attempts: z.number().int().nullable(),
  job_last_error_code: z.string().nullable(),
});

export function mapPanoramaRow(raw: unknown): PanoramaView {
  const row = rowSchema.parse(raw);
  const manifest = row.manifest === null ? null : panoramaManifestSchema.safeParse(row.manifest);
  return {
    versionId: row.version_id,
    assetId: row.asset_id,
    version: row.version,
    status: row.status,
    declaredBytes: row.declared_bytes,
    width: row.width,
    height: row.height,
    problem:
      row.status !== "rejected"
        ? null
        : PROBLEMS.includes(row.rejected_reason as PanoramaProblem)
          ? (row.rejected_reason as PanoramaProblem)
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

export function createPanoramaRepository(client: SessionClient): PanoramaRepository {
  return {
    async list(tenantId) {
      const { data, error } = await client.rpc("list_tenant_panoramas", { p_tenant_id: tenantId });
      if (error) throw new Error(`Listing panoramas failed (${error.code || "unknown"})`);
      return z.array(z.unknown()).parse(data).map(mapPanoramaRow);
    },

    async submit(tenantId, versionId) {
      const { data, error } = await client.rpc("submit_panorama", {
        p_tenant_id: tenantId,
        p_version_id: versionId,
      });
      if (error) {
        if (error.code === "42501") return "forbidden";
        if (error.code === "PT404") return "not_found";
        if (error.code === "PT409") return "not_uploaded";
        throw new Error(`Submitting a panorama failed (${error.code || "unknown"})`);
      }
      return z.enum(["processing", "ready", "rejected"]).parse(data);
    },
  };
}
