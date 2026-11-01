import {
  DOCUMENT_PROBLEMS,
  documentManifestSchema,
  knowledgeDocumentSchema,
  type DocumentVersionView,
  type KnowledgeIndexEntry,
  type KnowledgeListEntry,
  type KnowledgePassage,
  type KnowledgeRepository,
  type KnowledgeStatus,
} from "@rikuy/core";
import { z } from "zod";

import { contentAccess, createContentRepository, failure, unexpected } from "./content";
import type { SessionClient } from "./session-client";

/**
 * The assistant's knowledge with the signed-in user's session (migration
 * 20261102000100, ADR-037). Items are content of kind "knowledge": the same intent RPCs as
 * destinations, plus retire_content, documents (submit_document, document_version) and the
 * search and index status a member may see.
 */

const passageRowSchema = z.object({
  chunk_id: z.uuid(),
  source: z.enum(["content", "tour"]),
  source_id: z.uuid(),
  source_version: z.number().int(),
  kind: z.enum(["destination", "event", "knowledge"]),
  slug: z.string(),
  title: z.string(),
  heading: z.string().nullable(),
  body: z.string(),
  page_from: z.number().int().nullable(),
  page_to: z.number().int().nullable(),
  scene_id: z.uuid().nullable(),
  hotspot_id: z.uuid().nullable(),
  ended: z.boolean(),
  score: z.number(),
});

export function mapPassageRow(raw: unknown): KnowledgePassage {
  const row = passageRowSchema.parse(raw);
  return {
    chunkId: row.chunk_id,
    source: row.source,
    sourceId: row.source_id,
    sourceVersion: row.source_version,
    kind: row.kind,
    slug: row.slug,
    title: row.title,
    heading: row.heading,
    text: row.body,
    pages:
      row.page_from !== null && row.page_to !== null
        ? { from: row.page_from, to: row.page_to }
        : null,
    sceneId: row.scene_id,
    hotspotId: row.hotspot_id,
    ended: row.ended,
    score: row.score,
  };
}

const statusRowSchema = z.object({
  source: z.enum(["content", "tour"]),
  source_id: z.uuid(),
  kind: z.enum(["destination", "event", "knowledge"]),
  slug: z.string(),
  title: z.string(),
  revision_no: z.number().int(),
  published_at: z.string(),
  chunks: z.number().int().nullable(),
  indexed_at: z.string().nullable(),
  job_status: z.string().nullable(),
  job_error_code: z.string().nullable(),
});

const documentRowSchema = z.object({
  version_id: z.uuid(),
  asset_id: z.uuid(),
  version: z.number().int(),
  status: z.enum(["uploading", "processing", "ready", "rejected"]),
  declared_mime: z.string(),
  declared_bytes: z.number().int(),
  rejected_reason: z.string().nullable(),
  manifest: z.unknown().nullable(),
  job_status: z.enum(["pending", "running", "succeeded", "dead_letter"]).nullable(),
  job_last_error_code: z.string().nullable(),
});

function mapDocumentRow(raw: unknown): DocumentVersionView {
  const row = documentRowSchema.parse(raw);
  const manifest = documentManifestSchema.safeParse(row.manifest);
  const problem = (DOCUMENT_PROBLEMS as readonly string[]).includes(row.rejected_reason ?? "")
    ? (row.rejected_reason as DocumentVersionView["problem"])
    : row.status === "rejected"
      ? "unreadable"
      : null;
  return {
    versionId: row.version_id,
    assetId: row.asset_id,
    version: row.version,
    status: row.status,
    declaredMime: row.declared_mime,
    declaredBytes: row.declared_bytes,
    problem,
    manifest: manifest.success ? manifest.data : null,
    job: row.job_status ? { status: row.job_status, errorCode: row.job_last_error_code } : null,
  };
}

export function createKnowledgeRepository(client: SessionClient): KnowledgeRepository {
  const { revision, create, find } = contentAccess(client);
  const content = createContentRepository(client);

  return {
    async list(tenantId) {
      const items = await client
        .from("content_items")
        .select("id, slug, draft_revision_id, published_revision_id, updated_at, published_at")
        .eq("tenant_id", tenantId)
        .eq("kind", "knowledge");
      if (items.error) throw unexpected("Listing knowledge", items.error);
      const rows = z
        .array(
          z.object({
            id: z.uuid(),
            slug: z.string(),
            draft_revision_id: z.uuid().nullable(),
            published_revision_id: z.uuid().nullable(),
            updated_at: z.string(),
            published_at: z.string().nullable(),
          }),
        )
        .parse(items.data);
      if (rows.length === 0) return [];

      const revisions = await client
        .from("content_revisions")
        .select("id, content_id, revision_no, state, title")
        .eq("tenant_id", tenantId)
        .in(
          "content_id",
          rows.map((row) => row.id),
        );
      if (revisions.error) throw unexpected("Listing knowledge", revisions.error);
      const all = z
        .array(
          z.object({
            id: z.uuid(),
            content_id: z.uuid(),
            revision_no: z.number().int(),
            state: z.enum(["draft", "sealed"]),
            title: z.string(),
          }),
        )
        .parse(revisions.data);

      return rows
        .map((row): KnowledgeListEntry => {
          const own = all.filter((entry) => entry.content_id === row.id);
          const shown =
            own.find((entry) => entry.id === row.draft_revision_id) ??
            own.find((entry) => entry.id === row.published_revision_id) ??
            own.sort((a, b) => b.revision_no - a.revision_no)[0];
          const sealed = own.some((entry) => entry.state === "sealed");
          const status: KnowledgeStatus =
            row.published_revision_id === null
              ? sealed
                ? "retired"
                : "draft"
              : row.draft_revision_id === null
                ? "published"
                : "changed";
          return {
            contentId: row.id,
            slug: row.slug,
            title: shown?.title ?? row.slug,
            status,
            updatedAt: row.updated_at,
            publishedAt: row.published_at,
          };
        })
        .sort((a, b) => a.title.localeCompare(b.title, "es"));
    },

    create: (tenantId, slug, title) => create(tenantId, "knowledge", slug, title),

    find: (tenantId, contentId) => find(tenantId, contentId, "knowledge", knowledgeDocumentSchema),

    revisionDocument: (tenantId, revisionId) =>
      revision(tenantId, revisionId, knowledgeDocumentSchema),

    async saveDraft(tenantId, contentId, document, expectedEdit) {
      const { data, error, status } = await client.rpc("save_content_draft", {
        p_tenant_id: tenantId,
        p_content_id: contentId,
        p_document: document,
        p_expected_edit: expectedEdit,
      });
      if (error) {
        const kind = failure(error, status);
        if (kind === "invalid") {
          return { status: "invalid", reason: error.hint === "document" ? "document" : "shape" };
        }
        if (kind === null) throw unexpected("Saving the knowledge", error);
        return { status: kind };
      }
      const [row] = z
        .array(z.object({ revision_no: z.number().int(), edit_count: z.number().int() }))
        .length(1)
        .parse(data);
      if (!row) throw new Error("Saving the knowledge returned no row");
      return { status: "saved", revisionNo: row.revision_no, editCount: row.edit_count };
    },

    async publish(tenantId, contentId, expectedEdit) {
      const { data, error, status } = await client.rpc("publish_content", {
        p_tenant_id: tenantId,
        p_content_id: contentId,
        p_expected_edit: expectedEdit,
      });
      if (error) {
        if (error.hint === "document") return { status: "invalid", reason: "document" };
        const kind = failure(error, status);
        if (kind === "invalid") return { status: "invalid", reason: "incomplete" };
        if (kind === null) throw unexpected("Publishing the knowledge", error);
        return { status: kind };
      }
      const [row] = z
        .array(z.object({ revision_no: z.number().int() }))
        .length(1)
        .parse(data);
      if (!row) throw new Error("Publishing returned no row");
      return { status: "published", revisionNo: row.revision_no };
    },

    async retire(tenantId, contentId) {
      const { error, status } = await client.rpc("retire_content", {
        p_tenant_id: tenantId,
        p_content_id: contentId,
      });
      if (error) {
        const kind = failure(error, status);
        if (kind === null || kind === "invalid") throw unexpected("Retiring the knowledge", error);
        return { status: kind };
      }
      return { status: "retired" };
    },

    restore: (tenantId, contentId, revisionId) => content.restore(tenantId, contentId, revisionId),
    discardDraft: (tenantId, contentId, expectedEdit) =>
      content.discardDraft(tenantId, contentId, expectedEdit),

    async findDocument(tenantId, assetId, version) {
      const versionRow = await client
        .from("asset_versions")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("asset_id", assetId)
        .eq("version", version)
        .maybeSingle();
      if (versionRow.error) throw unexpected("Reading the document", versionRow.error);
      if (versionRow.data === null) return null;
      const { data, error, status } = await client.rpc("document_version", {
        p_tenant_id: tenantId,
        p_version_id: z.object({ id: z.uuid() }).parse(versionRow.data).id,
      });
      if (error) {
        if (failure(error, status) === "forbidden") return null;
        throw unexpected("Reading the document", error);
      }
      const [row] = z.array(z.unknown()).parse(data);
      return row === undefined ? null : mapDocumentRow(row);
    },

    async submitDocument(tenantId, versionId) {
      const { data, error, status } = await client.rpc("submit_document", {
        p_tenant_id: tenantId,
        p_version_id: versionId,
      });
      if (error) {
        if (error.hint === "not_uploaded") return "not_uploaded";
        const kind = failure(error, status);
        if (kind === "forbidden" || kind === "not_found") return kind;
        throw unexpected("Submitting the document", error);
      }
      return z.enum(["processing", "ready", "rejected"]).parse(data);
    },

    async search(tenantId, query, limit) {
      const { data, error } = await client.rpc("search_tenant_knowledge", {
        p_tenant_id: tenantId,
        p_query: query,
        p_limit: limit,
      });
      if (error) throw unexpected("Searching the knowledge", error);
      return z.array(z.unknown()).parse(data).map(mapPassageRow);
    },

    async indexStatus(tenantId) {
      const { data, error, status } = await client.rpc("knowledge_index_status", {
        p_tenant_id: tenantId,
      });
      if (error) {
        if (failure(error, status) === "forbidden") return [];
        throw unexpected("Reading what the assistant knows", error);
      }
      return z
        .array(statusRowSchema)
        .parse(data)
        .map((row): KnowledgeIndexEntry => ({
          source: row.source,
          sourceId: row.source_id,
          kind: row.kind,
          slug: row.slug,
          title: row.title,
          revisionNo: row.revision_no,
          publishedAt: row.published_at,
          chunks: row.chunks,
          indexedAt: row.indexed_at,
          job: row.job_status ? { status: row.job_status, errorCode: row.job_error_code } : null,
        }));
    },
  };
}
