import type { PostgrestError } from "@supabase/supabase-js";
import {
  tourRecordSchema,
  tourRevisionSchema,
  type ContentStatus,
  type TourEditOutcome,
  type TourListEntry,
  type TourRepository,
} from "@rikuy/core";
import { z } from "zod";

import type { SessionClient } from "./session-client";

/**
 * Tours with the signed-in user's session (migration 20261026000000): RLS filters the
 * reads and every write is an intent RPC that re-checks the role, the tenant and the
 * draft's edit number. Database codes become outcomes; the hint tells reasons apart.
 */

const listRowSchema = z.object({
  tour_id: z.uuid(),
  content_id: z.uuid(),
  content_kind: z.enum(["destination", "event"]),
  content_slug: z.string(),
  content_title: z.string(),
  content_published: z.boolean(),
  status: z.enum(["draft", "published", "changed"]),
  scenes: z.number().int(),
  updated_at: z.string(),
  published_at: z.string().nullable(),
});

const editRowSchema = z.array(z.object({ edit_count: z.number().int() })).length(1);

function unexpected(operation: string, error: PostgrestError): Error {
  return new Error(`${operation} failed (${error.code || "unknown"})`);
}

type Failure = "forbidden" | "not_found" | "conflict" | "invalid";

function failure(error: PostgrestError, status: number): Failure | null {
  if (error.code === "42501" || status === 403) return "forbidden";
  if (error.code === "PT404" || status === 404) return "not_found";
  if (error.code === "PT409" || status === 409) return "conflict";
  if (error.code === "23514") return "invalid";
  return null;
}

const INVALID_REASONS = [
  "title",
  "panorama",
  "limit",
  "target",
  "model",
  "body",
  "gallery",
  "position",
] as const;

function editFailure(operation: string, error: PostgrestError, status: number): TourEditOutcome {
  switch (failure(error, status)) {
    case "forbidden":
      return { status: "forbidden" };
    case "not_found":
      return { status: "not_found" };
    case "conflict":
      return error.hint === "duplicate" ? { status: "duplicate" } : { status: "conflict" };
    case "invalid":
      return {
        status: "invalid",
        reason: INVALID_REASONS.find((reason) => reason === error.hint) ?? "shape",
      };
    default:
      throw unexpected(operation, error);
  }
}

export function createTourRepository(client: SessionClient): TourRepository {
  async function edit(
    operation: string,
    fn: string,
    args: Record<string, unknown>,
  ): Promise<TourEditOutcome> {
    const { data, error, status } = await client.rpc(fn, args);
    if (error) return editFailure(operation, error, status);
    const [row] = editRowSchema.parse(data);
    if (!row) throw new Error(`${operation} returned no row`);
    return { status: "saved", editCount: row.edit_count };
  }

  return {
    async list(tenantId) {
      const { data, error } = await client.rpc("list_tenant_tours", { p_tenant_id: tenantId });
      if (error) throw unexpected("Listing tours", error);
      return z
        .array(listRowSchema)
        .parse(data)
        .map((row): TourListEntry => ({
          tourId: row.tour_id,
          contentId: row.content_id,
          contentKind: row.content_kind,
          contentSlug: row.content_slug,
          contentTitle: row.content_title,
          contentPublished: row.content_published,
          status: row.status satisfies ContentStatus,
          scenes: row.scenes,
          updatedAt: row.updated_at,
          publishedAt: row.published_at,
        }));
    },

    async find(tenantId, tourId) {
      const { data, error, status } = await client.rpc("tour_editor", {
        p_tenant_id: tenantId,
        p_tour_id: tourId,
      });
      if (error) {
        if (failure(error, status) === "not_found") return null;
        throw unexpected("Reading the tour", error);
      }
      return tourRecordSchema.parse(data);
    },

    async revision(tenantId, revisionId) {
      const { data, error, status } = await client.rpc("tour_revision_document", {
        p_tenant_id: tenantId,
        p_revision_id: revisionId,
      });
      if (error) {
        if (failure(error, status) === "not_found") return null;
        throw unexpected("Reading a tour revision", error);
      }
      return tourRevisionSchema.parse(data);
    },

    async create(tenantId, contentId) {
      const { data, error, status } = await client.rpc("create_tour", {
        p_tenant_id: tenantId,
        p_content_id: contentId,
      });
      if (error) {
        const outcome = failure(error, status);
        if (outcome === "conflict" && error.hint === "exists") return { status: "exists" };
        if (outcome === "forbidden" || outcome === "not_found") return { status: outcome };
        throw unexpected("Creating the tour", error);
      }
      const [row] = z
        .array(z.object({ tour_id: z.uuid() }))
        .length(1)
        .parse(data);
      if (!row) throw new Error("Creating the tour returned no row");
      return { status: "created", tourId: row.tour_id };
    },

    addScene(tenantId, tourId, expectedEdit, panoramaVersionId, title) {
      return edit("Adding a scene", "add_tour_scene", {
        p_tenant_id: tenantId,
        p_tour_id: tourId,
        p_expected_edit: expectedEdit,
        p_panorama_version_id: panoramaVersionId,
        p_title: title,
      });
    },

    updateScene(tenantId, tourId, expectedEdit, sceneId, changes) {
      return edit("Changing a scene", "update_tour_scene", {
        p_tenant_id: tenantId,
        p_tour_id: tourId,
        p_expected_edit: expectedEdit,
        p_scene_id: sceneId,
        p_changes: changes,
      });
    },

    moveScene(tenantId, tourId, expectedEdit, sceneId, position) {
      return edit("Moving a scene", "move_tour_scene", {
        p_tenant_id: tenantId,
        p_tour_id: tourId,
        p_expected_edit: expectedEdit,
        p_scene_id: sceneId,
        p_position: position,
      });
    },

    removeScene(tenantId, tourId, expectedEdit, sceneId) {
      return edit("Removing a scene", "remove_tour_scene", {
        p_tenant_id: tenantId,
        p_tour_id: tourId,
        p_expected_edit: expectedEdit,
        p_scene_id: sceneId,
      });
    },

    setEntryScene(tenantId, tourId, expectedEdit, sceneId) {
      return edit("Choosing the entry scene", "set_tour_entry_scene", {
        p_tenant_id: tenantId,
        p_tour_id: tourId,
        p_expected_edit: expectedEdit,
        p_scene_id: sceneId,
      });
    },

    async publish(tenantId, tourId, expectedEdit) {
      const { data, error, status } = await client.rpc("publish_tour", {
        p_tenant_id: tenantId,
        p_tour_id: tourId,
        p_expected_edit: expectedEdit,
      });
      if (error) {
        const outcome = failure(error, status);
        if (outcome === "invalid") return { status: "incomplete" };
        if (outcome === "conflict") {
          if (error.hint === "media" || error.hint === "poster") return { status: error.hint };
          return { status: "conflict" };
        }
        if (outcome) return { status: outcome };
        throw unexpected("Publishing the tour", error);
      }
      const [row] = z
        .array(z.object({ revision_no: z.number().int() }))
        .length(1)
        .parse(data);
      if (!row) throw new Error("Publishing the tour returned no row");
      return { status: "published", revisionNo: row.revision_no };
    },

    async restore(tenantId, tourId, revisionId) {
      const { data, error, status } = await client.rpc("restore_tour_revision", {
        p_tenant_id: tenantId,
        p_tour_id: tourId,
        p_revision_id: revisionId,
      });
      if (error) {
        const outcome = failure(error, status);
        if (outcome === "forbidden" || outcome === "not_found" || outcome === "conflict") {
          return { status: outcome };
        }
        throw unexpected("Restoring a tour revision", error);
      }
      const [row] = z
        .array(z.object({ revision_no: z.number().int() }))
        .length(1)
        .parse(data);
      if (!row) throw new Error("Restoring returned no row");
      return { status: "restored", revisionNo: row.revision_no };
    },

    async discardDraft(tenantId, tourId, expectedEdit) {
      const { error, status } = await client.rpc("discard_tour_draft", {
        p_tenant_id: tenantId,
        p_tour_id: tourId,
        p_expected_edit: expectedEdit,
      });
      if (error) {
        const outcome = failure(error, status);
        if (outcome === "conflict" && error.hint === "never_published") {
          return { status: "never_published" };
        }
        if (outcome === "forbidden" || outcome === "not_found" || outcome === "conflict") {
          return { status: outcome };
        }
        throw unexpected("Discarding the tour draft", error);
      }
      return { status: "discarded" };
    },

    addHotspot(tenantId, tourId, expectedEdit, sceneId, hotspot) {
      return edit("Adding a point", "add_tour_hotspot", {
        p_tenant_id: tenantId,
        p_tour_id: tourId,
        p_expected_edit: expectedEdit,
        p_scene_id: sceneId,
        p_hotspot: hotspot,
      });
    },

    updateHotspot(tenantId, tourId, expectedEdit, hotspotId, changes) {
      return edit("Changing a point", "update_tour_hotspot", {
        p_tenant_id: tenantId,
        p_tour_id: tourId,
        p_expected_edit: expectedEdit,
        p_hotspot_id: hotspotId,
        p_changes: changes,
      });
    },

    removeHotspot(tenantId, tourId, expectedEdit, hotspotId) {
      return edit("Removing a point", "remove_tour_hotspot", {
        p_tenant_id: tenantId,
        p_tour_id: tourId,
        p_expected_edit: expectedEdit,
        p_hotspot_id: hotspotId,
      });
    },

    async hotspotTargets(tenantId, tourId) {
      const { data, error } = await client.rpc("tour_hotspot_targets", {
        p_tenant_id: tenantId,
        p_tour_id: tourId,
      });
      if (error) throw unexpected("Listing point targets", error);
      return z
        .array(
          z.object({
            content_id: z.uuid(),
            kind: z.enum(["destination", "event"]),
            title: z.string(),
            published: z.boolean(),
            tour_published: z.boolean(),
          }),
        )
        .parse(data)
        .map((row) => ({
          contentId: row.content_id,
          kind: row.kind,
          title: row.title,
          published: row.published,
          tourPublished: row.tour_published,
        }));
    },
  };
}
