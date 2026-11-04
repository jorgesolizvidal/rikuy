import {
  COPILOT_ISSUES,
  eventScheduleSchema,
  richTextSchema,
  type CopilotRepository,
  type ProposalChanges,
  type ProposalField,
  type ProposalTarget,
} from "@rikuy/core";
import { z } from "zod";

import { failure, unexpected } from "./content";
import type { SessionClient } from "./session-client";

/**
 * The staff's Copilot with the signed-in user's session (migration 20261105000000,
 * ADR-042). Every call is an RPC that checks the role again; the table itself is never read
 * directly. Database codes become outcomes; the hint tells apart stale, expired and decided.
 */

const statusSchema = z.enum(["draft", "published", "changed"]);
const fieldSchema = z.enum(["title", "summary", "body", "description"]);

const reviewRowSchema = z.object({
  kind: z.enum(["destination", "event"]),
  content_id: z.uuid(),
  slug: z.string(),
  tour_id: z.uuid().nullable(),
  scene_id: z.uuid().nullable(),
  title: z.string(),
  scene_title: z.string().nullable(),
  status: statusSchema,
  // An issue a newer database knows and this build does not is left out, never a crash.
  issues: z
    .array(z.string())
    .transform((items) =>
      items.filter((item): item is (typeof COPILOT_ISSUES)[number] =>
        (COPILOT_ISSUES as readonly string[]).includes(item),
      ),
    ),
});

const snapshotSchema = z.object({
  timezone: z.string(),
  items: z.array(
    z.object({
      kind: z.enum(["destination", "event"]),
      contentId: z.uuid(),
      slug: z.string(),
      title: z.string(),
      summary: z.string(),
      status: statusSchema,
      schedule: eventScheduleSchema.nullable().catch(null),
      ended: z.boolean(),
      tour: z
        .object({ tourId: z.uuid(), status: statusSchema, scenes: z.number().int() })
        .nullable(),
    }),
  ),
});

const proposalStatusSchema = z.enum(["pending", "accepted", "rejected", "expired"]);

const listRowSchema = z.object({
  id: z.uuid(),
  target_kind: z.enum(["content", "scene"]),
  content_kind: z.enum(["destination", "event"]),
  content_id: z.uuid(),
  tour_id: z.uuid().nullable(),
  scene_id: z.uuid().nullable(),
  title: z.string().nullable(),
  scene_title: z.string().nullable(),
  fields: z.array(fieldSchema).nullable(),
  instruction: z.string(),
  status: proposalStatusSchema,
  stale: z.boolean(),
  accepted_fields: z.array(fieldSchema).nullable(),
  created_at: z.string(),
  expires_at: z.string(),
  decided_at: z.string().nullable(),
  mine: z.boolean(),
});

const valueSchema = z.union([z.string(), richTextSchema]);
const changesSchema = z.partialRecord(
  fieldSchema,
  z.object({ from: valueSchema, to: valueSchema }),
);

const viewRowSchema = listRowSchema.omit({ fields: true, mine: true }).extend({
  changes: changesSchema,
  sources: z.array(z.object({ label: z.string(), title: z.string() })),
});

function target(row: {
  target_kind: "content" | "scene";
  content_id: string;
  tour_id: string | null;
  scene_id: string | null;
}): ProposalTarget {
  return row.target_kind === "scene" && row.tour_id && row.scene_id
    ? { type: "scene", tourId: row.tour_id, sceneId: row.scene_id }
    : { type: "content", contentId: row.content_id };
}

function common(row: Omit<z.infer<typeof viewRowSchema>, "changes" | "sources">) {
  return {
    id: row.id,
    target: target(row),
    contentKind: row.content_kind,
    contentId: row.content_id,
    title: row.title ?? "",
    sceneTitle: row.scene_title,
    instruction: row.instruction,
    status: row.status,
    stale: row.stale,
    acceptedFields: row.accepted_fields,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
  };
}

export function createCopilotRepository(client: SessionClient): CopilotRepository {
  return {
    async review(tenantId) {
      const { data, error } = await client.rpc("copilot_content_review", { p_tenant_id: tenantId });
      if (error) throw unexpected("Reading the content review", error);
      return z
        .array(reviewRowSchema)
        .parse(data)
        .map((row) => ({
          kind: row.kind,
          contentId: row.content_id,
          slug: row.slug,
          tourId: row.tour_id,
          sceneId: row.scene_id,
          title: row.title,
          sceneTitle: row.scene_title,
          status: row.status,
          issues: row.issues,
        }));
    },

    async snapshot(tenantId) {
      const { data, error } = await client.rpc("copilot_snapshot", { p_tenant_id: tenantId });
      if (error) throw unexpected("Reading the Copilot's snapshot", error);
      return snapshotSchema.parse(data);
    },

    async createProposal(input) {
      const { data, error, status } = await client.rpc("create_copilot_proposal", {
        p_tenant_id: input.tenantId,
        p_target:
          input.target.type === "content"
            ? { contentId: input.target.contentId }
            : { tourId: input.target.tourId, sceneId: input.target.sceneId },
        p_base_revision_id: input.baseRevisionId,
        p_base_edit: input.baseEdit,
        p_changes: input.changes,
        p_sources: input.sources,
        p_instruction: input.instruction,
        p_ai_request_id: input.aiRequestId,
      });
      if (error) {
        const outcome = failure(error, status);
        if (outcome === "conflict") return { status: "stale" };
        if (outcome === "invalid") {
          return { status: error.hint === "unchanged" ? "unchanged" : "invalid" };
        }
        if (outcome === "forbidden" || outcome === "not_found") return { status: outcome };
        throw unexpected("Saving the proposal", error);
      }
      return { status: "created", proposalId: z.uuid().parse(data) };
    },

    async listProposals(tenantId) {
      const { data, error } = await client.rpc("list_copilot_proposals", { p_tenant_id: tenantId });
      if (error) throw unexpected("Listing proposals", error);
      return z
        .array(listRowSchema)
        .parse(data)
        .map((row) => ({
          ...common(row),
          fields: (row.fields ?? []) as ProposalField[],
          mine: row.mine,
        }));
    },

    async proposal(tenantId, proposalId) {
      if (!z.uuid().safeParse(proposalId).success) return null;
      const { data, error, status } = await client.rpc("copilot_proposal", {
        p_tenant_id: tenantId,
        p_proposal_id: proposalId,
      });
      if (error) {
        if (failure(error, status) === "forbidden") return null;
        throw unexpected("Reading the proposal", error);
      }
      const [row] = z.array(viewRowSchema).max(1).parse(data);
      if (!row) return null;
      return {
        ...common(row),
        changes: row.changes as ProposalChanges,
        sources: row.sources,
      };
    },

    async accept(tenantId, proposalId, fields) {
      if (!z.uuid().safeParse(proposalId).success) return { status: "not_found" };
      const { data, error, status } = await client.rpc("accept_copilot_proposal", {
        p_tenant_id: tenantId,
        p_proposal_id: proposalId,
        p_fields: fields,
      });
      if (error) {
        const outcome = failure(error, status);
        if (outcome === "conflict") {
          return {
            status:
              error.hint === "expired" ? "expired" : error.hint === "decided" ? "decided" : "stale",
          };
        }
        if (outcome === "invalid" || outcome === "forbidden" || outcome === "not_found") {
          return { status: outcome };
        }
        throw unexpected("Accepting the proposal", error);
      }
      const [row] = z
        .array(z.object({ revision_no: z.number().int(), edit_count: z.number().int() }))
        .length(1)
        .parse(data);
      if (!row) throw new Error("Accepting the proposal returned no row");
      return { status: "accepted", revisionNo: row.revision_no, editCount: row.edit_count };
    },

    async reject(tenantId, proposalId) {
      if (!z.uuid().safeParse(proposalId).success) return { status: "not_found" };
      const { error, status } = await client.rpc("reject_copilot_proposal", {
        p_tenant_id: tenantId,
        p_proposal_id: proposalId,
      });
      if (error) {
        const outcome = failure(error, status);
        if (outcome === "conflict") return { status: "decided" };
        if (outcome === "forbidden" || outcome === "not_found") return { status: outcome };
        throw unexpected("Rejecting the proposal", error);
      }
      return { status: "rejected" };
    },
  };
}
