import {
  FAQ_TOPICS,
  faqDocumentSchema,
  richTextSchema,
  type FaqListEntry,
  type FaqRepository,
  type FaqStatus,
  type PublishedFaq,
  type PublishedFaqReader,
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
import { createNoticeRepository } from "./notices";
import type { SessionClient } from "./session-client";

/**
 * The municipality's frequently asked questions (migration 20261205000100, ADR-074). Items are
 * content of kind "faq": the same intent RPCs as destinations, plus retire_content; the portal
 * reads the published ones with portal_faqs.
 *
 * The web app can be deployed a few minutes before the migration: until then the kind does not
 * exist (22P02) and the columns are missing (42703), and the panel says there are none.
 */

const beforeMigration = (error: PostgrestError | null) =>
  error?.code === "22P02" || error?.code === "42703" || isMissingFunction(error);

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
  faq_topic: z.enum(FAQ_TOPICS).nullable().catch(null),
});

export function createFaqRepository(client: SessionClient): FaqRepository {
  const { revision, create, find } = contentAccess(client);
  const content = createContentRepository(client);
  const notices = createNoticeRepository(client);

  return {
    async list(tenantId) {
      const items = await client
        .from("content_items")
        .select("id, slug, draft_revision_id, published_revision_id, updated_at, published_at")
        .eq("tenant_id", tenantId)
        .eq("kind", "faq");
      if (beforeMigration(items.error)) return [];
      if (items.error) throw unexpected("Listing questions", items.error);
      const rows = z.array(itemRowSchema).parse(items.data);
      if (rows.length === 0) return [];

      const revisions = await client
        .from("content_revisions")
        .select("id, content_id, revision_no, state, title, faq_topic")
        .eq("tenant_id", tenantId)
        .in(
          "content_id",
          rows.map((row) => row.id),
        );
      if (beforeMigration(revisions.error)) return [];
      if (revisions.error) throw unexpected("Listing questions", revisions.error);
      const all = z.array(revisionRowSchema).parse(revisions.data);

      return rows.map((row): FaqListEntry => {
        const own = all.filter((entry) => entry.content_id === row.id);
        const shown =
          own.find((entry) => entry.id === row.draft_revision_id) ??
          own.find((entry) => entry.id === row.published_revision_id) ??
          [...own].sort((a, b) => b.revision_no - a.revision_no)[0];
        const sealed = own.some((entry) => entry.state === "sealed");
        const status: FaqStatus =
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
          question: shown?.title ?? row.slug,
          topic: shown?.faq_topic ?? "other",
          status,
          updatedAt: row.updated_at,
          publishedAt: row.published_at,
        };
      });
    },

    // The same destinations and events a notice may name (ADR-069).
    async places(tenantId) {
      const places = await notices.places(tenantId);
      return places.map((place) => ({
        contentId: place.contentId,
        kind: place.kind,
        title: place.title,
      }));
    },

    create: (tenantId, slug, title) => create(tenantId, "faq", slug, title),

    find: (tenantId, contentId) => find(tenantId, contentId, "faq", faqDocumentSchema),

    revisionDocument: (tenantId, revisionId) => revision(tenantId, revisionId, faqDocumentSchema),

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
          return error.hint === "place"
            ? { status: "invalid", reason: "place" }
            : { status: "invalid" };
        }
        if (kind === null) throw unexpected("Saving the question", error);
        return { status: kind };
      }
      const [row] = z
        .array(z.object({ revision_no: z.number().int(), edit_count: z.number().int() }))
        .length(1)
        .parse(data);
      if (!row) throw new Error("Saving the question returned no row");
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
          return { status: "invalid", reason: "incomplete" };
        }
        if (kind === null) throw unexpected("Publishing the question", error);
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
        if (kind === null || kind === "invalid") throw unexpected("Retiring the question", error);
        return { status: kind };
      }
      return { status: "retired" };
    },

    restore: (tenantId, contentId, revisionId) => content.restore(tenantId, contentId, revisionId),
    discardDraft: (tenantId, contentId, expectedEdit) =>
      content.discardDraft(tenantId, contentId, expectedEdit),
  };
}

// ── The portal (anonymous) ───────────────────────────────────────────────────

const portalFaqSchema = z.object({
  slug: z.string(),
  question: z.string(),
  answer: z.string(),
  body: richTextSchema.catch([]),
  topic: z.enum(FAQ_TOPICS).catch("other"),
  place_kind: z.enum(["destination", "event"]).nullable().catch(null),
  place_slug: z.string().nullable(),
  place_title: z.string().nullable(),
  published_at: z.string(),
});

export function mapPortalFaqRow(raw: unknown): PublishedFaq {
  const row = portalFaqSchema.parse(raw);
  return {
    slug: row.slug,
    question: row.question,
    answer: row.answer,
    body: row.body,
    topic: row.topic,
    place:
      row.place_kind !== null && row.place_slug !== null && row.place_title !== null
        ? { kind: row.place_kind, slug: row.place_slug, title: row.place_title }
        : null,
    publishedAt: row.published_at,
  };
}

export function createSupabasePublishedFaqReader(
  options: SupabasePublishedContentReaderOptions,
): PublishedFaqReader {
  const client = createClient(options.url, options.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
  });
  const timeoutMs = options.timeoutMs ?? 3_000;
  return {
    async list(tenantId) {
      const { data, error } = await client
        .rpc("portal_faqs", { p_tenant_id: tenantId })
        .abortSignal(AbortSignal.timeout(timeoutMs));
      // Before the migration (the web app goes first): no questions.
      if (isMissingFunction(error)) return [];
      if (error) throw unexpected("Listing the questions", error);
      return z.array(z.unknown()).parse(data).map(mapPortalFaqRow);
    },
  };
}
