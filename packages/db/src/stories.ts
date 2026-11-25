import {
  richTextSchema,
  storyDocumentSchema,
  storyTeller,
  type PublishedStory,
  type PublishedStoryReader,
  type StoryListEntry,
  type StoryRepository,
  type StoryStatus,
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
 * The community's stories (migration 20261130000100, ADR-069). Items are content of kind
 * "story": the same intent RPCs as destinations, plus retire_content; the portal reads the
 * published ones with portal_stories.
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
  story_author: z.string().nullable().catch(null),
  story_anonymous: z.boolean().nullable().catch(null),
});

export function createStoryRepository(client: SessionClient): StoryRepository {
  const { revision, create, find } = contentAccess(client);
  const content = createContentRepository(client);
  const notices = createNoticeRepository(client);

  return {
    async list(tenantId) {
      const items = await client
        .from("content_items")
        .select("id, slug, draft_revision_id, published_revision_id, updated_at, published_at")
        .eq("tenant_id", tenantId)
        .eq("kind", "story");
      if (beforeMigration(items.error)) return [];
      if (items.error) throw unexpected("Listing stories", items.error);
      const rows = z.array(itemRowSchema).parse(items.data);
      if (rows.length === 0) return [];

      const revisions = await client
        .from("content_revisions")
        .select("id, content_id, revision_no, state, title, story_author, story_anonymous")
        .eq("tenant_id", tenantId)
        .in(
          "content_id",
          rows.map((row) => row.id),
        );
      if (beforeMigration(revisions.error)) return [];
      if (revisions.error) throw unexpected("Listing stories", revisions.error);
      const all = z.array(revisionRowSchema).parse(revisions.data);

      return rows.map((row): StoryListEntry => {
        const own = all.filter((entry) => entry.content_id === row.id);
        const shown =
          own.find((entry) => entry.id === row.draft_revision_id) ??
          own.find((entry) => entry.id === row.published_revision_id) ??
          [...own].sort((a, b) => b.revision_no - a.revision_no)[0];
        const sealed = own.some((entry) => entry.state === "sealed");
        const status: StoryStatus =
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
          teller:
            shown && (shown.story_anonymous === true || shown.story_author)
              ? storyTeller({
                  author: shown.story_author,
                  anonymous: shown.story_anonymous === true,
                })
              : null,
          status,
          updatedAt: row.updated_at,
          publishedAt: row.published_at,
        };
      });
    },

    // The same destinations a notice may name, without the events (ADR-069).
    async places(tenantId) {
      const places = await notices.places(tenantId);
      return places
        .filter((place) => place.kind === "destination")
        .map((place) => ({ contentId: place.contentId, title: place.title }));
    },

    create: (tenantId, slug, title) => create(tenantId, "story", slug, title),

    find: (tenantId, contentId) => find(tenantId, contentId, "story", storyDocumentSchema),

    revisionDocument: (tenantId, revisionId) => revision(tenantId, revisionId, storyDocumentSchema),

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
        if (kind === null) throw unexpected("Saving the story", error);
        return { status: kind };
      }
      const [row] = z
        .array(z.object({ revision_no: z.number().int(), edit_count: z.number().int() }))
        .length(1)
        .parse(data);
      if (!row) throw new Error("Saving the story returned no row");
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
          return { status: "invalid", reason: error.hint === "consent" ? "consent" : "incomplete" };
        }
        if (kind === null) throw unexpected("Publishing the story", error);
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
        if (kind === null || kind === "invalid") throw unexpected("Retiring the story", error);
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

const portalStorySchema = z.object({
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  body: richTextSchema.catch([]),
  author: z.string().nullable(),
  anonymous: z.boolean(),
  community: z.string().nullable(),
  place_slug: z.string().nullable(),
  place_title: z.string().nullable(),
  published_at: z.string(),
});

export function mapPortalStoryRow(raw: unknown): PublishedStory {
  const row = portalStorySchema.parse(raw);
  return {
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    body: row.body,
    // An anonymous story never shows a name, even if one slipped through.
    author: row.anonymous ? null : row.author,
    anonymous: row.anonymous,
    community: row.community,
    place:
      row.place_slug !== null && row.place_title !== null
        ? { slug: row.place_slug, title: row.place_title }
        : null,
    publishedAt: row.published_at,
  };
}

export function createSupabasePublishedStoryReader(
  options: SupabasePublishedContentReaderOptions,
): PublishedStoryReader {
  const client = createClient(options.url, options.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
  });
  const timeoutMs = options.timeoutMs ?? 3_000;
  return {
    async list(tenantId) {
      const { data, error } = await client
        .rpc("portal_stories", { p_tenant_id: tenantId })
        .abortSignal(AbortSignal.timeout(timeoutMs));
      // Before the migration (the web app goes first): no stories.
      if (isMissingFunction(error)) return [];
      if (error) throw unexpected("Listing the stories", error);
      return z.array(z.unknown()).parse(data).map(mapPortalStoryRow);
    },
  };
}
