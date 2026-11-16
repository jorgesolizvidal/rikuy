import {
  noticeDocumentSchema,
  richTextSchema,
  type NoticeListEntry,
  type NoticePlaceOption,
  type NoticeRepository,
  type NoticeStatus,
  type NoticeValidity,
  type PublishedNotice,
  type PublishedNoticeReader,
} from "@rikuy/core";
import { createClient, type PostgrestError } from "@supabase/supabase-js";
import { z } from "zod";

import {
  contentAccess,
  createContentRepository,
  failure,
  unexpected,
  type SupabasePublishedContentReaderOptions,
} from "./content";
import { isMissingFunction } from "./missing-function";
import type { SessionClient } from "./session-client";

/**
 * The municipality's notices (migration 20261127000100, ADR-069). Items are content of kind
 * "notice": the same intent RPCs as destinations, plus retire_content; the portal reads the
 * ones in force with portal_notices.
 *
 * The web app can be deployed a few minutes before the migration: until then the kind does
 * not exist (22P02) and the columns are missing (42703), and the panel says there are none.
 */

const beforeMigration = (error: PostgrestError | null) =>
  error?.code === "22P02" || error?.code === "42703" || isMissingFunction(error);

/** `2026-12-01T08:00:00` (timestamp without time zone) → `2026-12-01T08:00`. */
const localMinute = z
  .string()
  .nullable()
  .transform((value) => (value === null ? null : value.slice(0, 16)));

const itemRowSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  draft_revision_id: z.uuid().nullable(),
  published_revision_id: z.uuid().nullable(),
  updated_at: z.string(),
  published_at: z.string().nullable(),
});

const revisionRowSchema = z.object({
  id: z.uuid(),
  content_id: z.uuid(),
  revision_no: z.number().int(),
  state: z.enum(["draft", "sealed"]),
  title: z.string(),
  notice_from_local: localMinute,
  notice_until_local: localMinute,
});

const validityOf = (row: z.infer<typeof revisionRowSchema>): NoticeValidity => ({
  from: row.notice_from_local,
  until: row.notice_until_local,
});

export function createNoticeRepository(client: SessionClient): NoticeRepository {
  const { revision, create, find } = contentAccess(client);
  const content = createContentRepository(client);

  return {
    async list(tenantId) {
      const items = await client
        .from("content_items")
        .select("id, slug, draft_revision_id, published_revision_id, updated_at, published_at")
        .eq("tenant_id", tenantId)
        .eq("kind", "notice");
      if (beforeMigration(items.error)) return [];
      if (items.error) throw unexpected("Listing notices", items.error);
      const rows = z.array(itemRowSchema).parse(items.data);
      if (rows.length === 0) return [];

      const revisions = await client
        .from("content_revisions")
        .select("id, content_id, revision_no, state, title, notice_from_local, notice_until_local")
        .eq("tenant_id", tenantId)
        .in(
          "content_id",
          rows.map((row) => row.id),
        );
      if (beforeMigration(revisions.error)) return [];
      if (revisions.error) throw unexpected("Listing notices", revisions.error);
      const all = z.array(revisionRowSchema).parse(revisions.data);

      return rows.map((row): NoticeListEntry => {
        const own = all.filter((entry) => entry.content_id === row.id);
        const published = own.find((entry) => entry.id === row.published_revision_id);
        const shown =
          own.find((entry) => entry.id === row.draft_revision_id) ??
          published ??
          [...own].sort((a, b) => b.revision_no - a.revision_no)[0];
        const sealed = own.some((entry) => entry.state === "sealed");
        const status: NoticeStatus =
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
          published: published ? validityOf(published) : null,
          validity: shown ? validityOf(shown) : { from: null, until: null },
          updatedAt: row.updated_at,
          publishedAt: row.published_at,
        };
      });
    },

    create: (tenantId, slug, title) => create(tenantId, "notice", slug, title),

    find: (tenantId, contentId) => find(tenantId, contentId, "notice", noticeDocumentSchema),

    revisionDocument: (tenantId, revisionId) =>
      revision(tenantId, revisionId, noticeDocumentSchema),

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
          return { status: "invalid", reason: error.hint === "place" ? "place" : "shape" };
        }
        if (kind === null) throw unexpected("Saving the notice", error);
        return { status: kind };
      }
      const [row] = z
        .array(z.object({ revision_no: z.number().int(), edit_count: z.number().int() }))
        .length(1)
        .parse(data);
      if (!row) throw new Error("Saving the notice returned no row");
      return { status: "saved", revisionNo: row.revision_no, editCount: row.edit_count };
    },

    async publish(tenantId, contentId, expectedEdit) {
      const { data, error, status } = await client.rpc("publish_content", {
        p_tenant_id: tenantId,
        p_content_id: contentId,
        p_expected_edit: expectedEdit,
      });
      if (error) {
        const kind = failure(error, status);
        if (kind === "invalid") {
          return {
            status: "invalid",
            reason: error.hint === "validity" ? "validity" : "incomplete",
          };
        }
        if (kind === null) throw unexpected("Publishing the notice", error);
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
        if (kind === null || kind === "invalid") throw unexpected("Retiring the notice", error);
        return { status: kind };
      }
      return { status: "retired" };
    },

    restore: (tenantId, contentId, revisionId) => content.restore(tenantId, contentId, revisionId),
    discardDraft: (tenantId, contentId, expectedEdit) =>
      content.discardDraft(tenantId, contentId, expectedEdit),

    async timezone(tenantId) {
      const { data, error } = await client
        .from("tenants")
        .select("timezone")
        .eq("id", tenantId)
        .maybeSingle();
      if (error) throw unexpected("Reading the time zone", error);
      return z.object({ timezone: z.string() }).nullable().parse(data)?.timezone ?? "UTC";
    },

    async places(tenantId) {
      const items = await client
        .from("content_items")
        .select("id, kind, draft_revision_id, published_revision_id")
        .eq("tenant_id", tenantId)
        .in("kind", ["destination", "event"]);
      if (items.error) throw unexpected("Listing places for notices", items.error);
      const rows = z
        .array(
          z.object({
            id: z.uuid(),
            kind: z.enum(["destination", "event"]),
            draft_revision_id: z.uuid().nullable(),
            published_revision_id: z.uuid().nullable(),
          }),
        )
        .parse(items.data);
      const ids = rows
        .map((row) => row.published_revision_id ?? row.draft_revision_id)
        .filter((id): id is string => id !== null);
      if (ids.length === 0) return [];
      const titles = await client.from("content_revisions").select("id, title").in("id", ids);
      if (titles.error) throw unexpected("Listing places for notices", titles.error);
      const byId = new Map(
        z
          .array(z.object({ id: z.uuid(), title: z.string() }))
          .parse(titles.data)
          .map((row) => [row.id, row.title]),
      );
      return rows
        .map((row): NoticePlaceOption | null => {
          const title = byId.get(row.published_revision_id ?? row.draft_revision_id ?? "");
          return title ? { contentId: row.id, kind: row.kind, title } : null;
        })
        .filter((row): row is NoticePlaceOption => row !== null)
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title, "es"));
    },
  };
}

// ── The portal (anonymous) ───────────────────────────────────────────────────

const portalNoticeSchema = z.object({
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  body: richTextSchema.catch([]),
  starts_at: z.string().nullable(),
  ends_at: z.string(),
  place_kind: z.enum(["destination", "event"]).nullable(),
  place_slug: z.string().nullable(),
  place_title: z.string().nullable(),
});

export function mapPortalNoticeRow(raw: unknown): PublishedNotice {
  const row = portalNoticeSchema.parse(raw);
  return {
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    body: row.body,
    startsAt: row.starts_at === null ? null : new Date(row.starts_at).toISOString(),
    endsAt: new Date(row.ends_at).toISOString(),
    place:
      row.place_kind && row.place_slug && row.place_title
        ? { kind: row.place_kind, slug: row.place_slug, title: row.place_title }
        : null,
  };
}

export function createSupabasePublishedNoticeReader(
  options: SupabasePublishedContentReaderOptions,
): PublishedNoticeReader {
  const client = createClient(options.url, options.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
  });
  const timeoutMs = options.timeoutMs ?? 3_000;
  return {
    async list(tenantId) {
      const { data, error } = await client
        .rpc("portal_notices", { p_tenant_id: tenantId })
        .abortSignal(AbortSignal.timeout(timeoutMs));
      // Before the migration (the web app goes first): no notices.
      if (isMissingFunction(error)) return [];
      if (error) throw unexpected("Listing the notices", error);
      return z.array(z.unknown()).parse(data).map(mapPortalNoticeRow);
    },
  };
}
