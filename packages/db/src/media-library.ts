import type { PostgrestError } from "@supabase/supabase-js";
import type { MediaLibraryRepository, MediaUse } from "@rikuy/core";
import { z } from "zod";

import { failure, unexpected } from "./content";
import { isMissingFunction } from "./missing-function";
import type { SessionClient } from "./session-client";

/**
 * Replacing and deleting panoramas and models (migration 20261111000000, ADR-048), with the
 * signed-in user's session: the RPCs check role and tenant again. Before the migration is
 * applied (the web ships a few minutes earlier), nothing is listed as used.
 */
const useRowSchema = z.object({
  asset_id: z.uuid(),
  tour_id: z.uuid(),
  content_id: z.uuid(),
  content_kind: z.enum(["destination", "event"]),
  content_title: z.string(),
  scope: z.enum(["draft", "published", "history"]),
  working: z.boolean(),
  version: z.number().int(),
});

export function createMediaLibraryRepository(client: SessionClient): MediaLibraryRepository {
  return {
    async uses(tenantId, purpose) {
      const { data, error } = await client.rpc("media_asset_uses", {
        p_tenant_id: tenantId,
        p_purpose: purpose,
      });
      if (error) {
        if (isMissingFunction(error)) return [];
        throw unexpected("Reading where media is used", error);
      }
      return z
        .array(useRowSchema)
        .parse(data)
        .map((row): MediaUse => ({
          assetId: row.asset_id,
          tourId: row.tour_id,
          contentId: row.content_id,
          contentKind: row.content_kind,
          contentTitle: row.content_title,
          scope: row.scope,
          working: row.working,
          version: row.version,
        }));
    },

    async applyReplacement(tenantId, versionId) {
      const { data, error, status } = await client.rpc("apply_media_replacement", {
        p_tenant_id: tenantId,
        p_version_id: versionId,
      });
      if (error) {
        const kind = failure(error, status);
        if (kind === "conflict") {
          return { status: (error as PostgrestError).hint === "stale" ? "stale" : "not_ready" };
        }
        if (kind === "forbidden" || kind === "not_found") return { status: kind };
        throw unexpected("Using the new version", error);
      }
      const rows = z.array(z.object({ tour_id: z.uuid(), opened_draft: z.boolean() })).parse(data);
      return {
        status: "applied",
        tours: rows.length,
        openedDrafts: rows.filter((row) => row.opened_draft).length,
      };
    },

    async deleteAsset(tenantId, assetId) {
      const { error, status } = await client.rpc("delete_media_asset", {
        p_tenant_id: tenantId,
        p_asset_id: assetId,
      });
      if (error) {
        const kind = failure(error, status);
        if (kind === "conflict") {
          return { status: (error as PostgrestError).hint === "busy" ? "busy" : "in_use" };
        }
        if (kind === "forbidden" || kind === "not_found") return { status: kind };
        throw unexpected("Deleting", error);
      }
      return { status: "deleted" };
    },
  };
}
