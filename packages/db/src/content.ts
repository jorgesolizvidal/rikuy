import { createClient, type PostgrestError } from "@supabase/supabase-js";
import {
  destinationDocumentSchema,
  eventDocumentSchema,
  eventScheduleSchema,
  richTextSchema,
  type ContentRecord,
  type ContentRepository,
  type ContentStatus,
  type PublishedDestinationReader,
  type PublishedEventReader,
} from "@rikuy/core";
import { z } from "zod";

import type { SessionClient } from "./session-client";

/**
 * Editorial content adapters (migration 20261018200000).
 *
 * - The repository uses the signed-in user's session: reads are filtered by RLS and every
 *   write is an intent RPC that re-checks the role. Database codes become outcomes; the
 *   hint tells apart the reasons (slug, media, incomplete, never_published).
 * - The published reader is anonymous and only sees published revisions of active tenants.
 */

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
  revision_no: z.number().int(),
  state: z.enum(["draft", "sealed"]),
  edit_count: z.number().int(),
  title: z.string(),
  updated_at: z.string(),
  sealed_at: z.string().nullable(),
});

function unexpected(operation: string, error: PostgrestError): Error {
  return new Error(`${operation} failed (${error.code || "unknown"})`);
}

function failure(error: PostgrestError, status: number) {
  if (error.code === "42501" || status === 403) return "forbidden" as const;
  if (error.code === "PT404" || status === 404) return "not_found" as const;
  if (error.code === "PT409" || status === 409) return "conflict" as const;
  if (error.code === "23514") return "invalid" as const;
  return null;
}

function statusOf(item: z.infer<typeof itemRowSchema>): ContentStatus {
  if (item.published_revision_id === null) return "draft";
  return item.draft_revision_id === null ? "published" : "changed";
}

type Kind = "destination" | "event";

function eventStatus(published: boolean, draft: boolean): ContentStatus {
  if (!published) return "draft";
  return draft ? "changed" : "published";
}

export function createContentRepository(client: SessionClient): ContentRepository {
  async function revision<D>(
    tenantId: string,
    revisionId: string,
    schema: z.ZodType<D>,
  ): Promise<D | null> {
    const { data, error, status } = await client.rpc("content_revision_document", {
      p_tenant_id: tenantId,
      p_revision_id: revisionId,
    });
    if (error) {
      if (failure(error, status) === "not_found") return null;
      throw unexpected("Reading a revision", error);
    }
    return schema.parse(data);
  }

  async function create(tenantId: string, kind: Kind, slug: string, title: string) {
    const { data, error, status } = await client.rpc("create_content_item", {
      p_tenant_id: tenantId,
      p_kind: kind,
      p_slug: slug,
      p_title: title,
    });
    if (error) {
      const outcome = failure(error, status);
      if (outcome === "conflict" && error.hint === "slug") return { status: "slug_taken" as const };
      if (outcome === "forbidden" || outcome === "invalid") return { status: outcome };
      throw unexpected(`Creating the ${kind}`, error);
    }
    const [row] = z
      .array(z.object({ content_id: z.uuid() }))
      .length(1)
      .parse(data);
    if (!row) throw new Error(`Creating the ${kind} returned no row`);
    return { status: "created" as const, contentId: row.content_id };
  }

  async function find<D>(
    tenantId: string,
    contentId: string,
    kind: Kind,
    schema: z.ZodType<D>,
  ): Promise<ContentRecord<D> | null> {
    const item = await client
      .from("content_items")
      .select("id, slug, draft_revision_id, published_revision_id, updated_at, published_at")
      .eq("tenant_id", tenantId)
      .eq("id", contentId)
      .eq("kind", kind)
      .maybeSingle();
    if (item.error) throw unexpected(`Reading the ${kind}`, item.error);
    if (item.data === null) return null;
    const row = itemRowSchema.parse(item.data);

    const revisions = await client
      .from("content_revisions")
      .select("id, revision_no, state, edit_count, title, updated_at, sealed_at")
      .eq("tenant_id", tenantId)
      .eq("content_id", contentId);
    if (revisions.error) throw unexpected("Reading revisions", revisions.error);
    const all = z.array(revisionRowSchema).parse(revisions.data);

    const draftRow = all.find((entry) => entry.id === row.draft_revision_id);
    const publishedRow = all.find((entry) => entry.id === row.published_revision_id);
    const [draftDocument, publishedDocument] = await Promise.all([
      draftRow ? revision(tenantId, draftRow.id, schema) : null,
      publishedRow ? revision(tenantId, publishedRow.id, schema) : null,
    ]);

    return {
      contentId: row.id,
      tenantId,
      slug: row.slug,
      draft:
        draftRow && draftDocument
          ? {
              revisionId: draftRow.id,
              revisionNo: draftRow.revision_no,
              editCount: draftRow.edit_count,
              updatedAt: draftRow.updated_at,
              document: draftDocument,
            }
          : null,
      published:
        publishedRow && publishedDocument
          ? {
              revisionId: publishedRow.id,
              revisionNo: publishedRow.revision_no,
              document: publishedDocument,
            }
          : null,
      history: all
        .filter((entry) => entry.state === "sealed" && entry.sealed_at !== null)
        .sort((a, b) => b.revision_no - a.revision_no)
        .map((entry) => ({
          revisionId: entry.id,
          revisionNo: entry.revision_no,
          title: entry.title,
          sealedAt: entry.sealed_at ?? "",
        })),
    };
  }

  return {
    async listDestinations(tenantId) {
      const items = await client
        .from("content_items")
        .select("id, slug, draft_revision_id, published_revision_id, updated_at, published_at")
        .eq("tenant_id", tenantId)
        .eq("kind", "destination");
      if (items.error) throw unexpected("Listing destinations", items.error);
      const rows = z.array(itemRowSchema).parse(items.data);
      if (rows.length === 0) return [];

      // The title shown is the one editors are working on: open draft, else published.
      const shown = rows.map((row) => row.draft_revision_id ?? row.published_revision_id);
      const ids = shown.filter((id): id is string => id !== null);
      const titles = await client.from("content_revisions").select("id, title").in("id", ids);
      if (titles.error) throw unexpected("Listing destinations", titles.error);
      const byId = new Map(
        z
          .array(z.object({ id: z.uuid(), title: z.string() }))
          .parse(titles.data)
          .map((row) => [row.id, row.title]),
      );

      return rows
        .map((row, index) => ({
          contentId: row.id,
          slug: row.slug,
          title: byId.get(shown[index] ?? "") ?? row.slug,
          status: statusOf(row),
          updatedAt: row.updated_at,
          publishedAt: row.published_at,
        }))
        .sort((a, b) => a.title.localeCompare(b.title, "es"));
    },

    createDestination: (tenantId, slug, title) => create(tenantId, "destination", slug, title),

    findDestination: (tenantId, contentId) =>
      find(tenantId, contentId, "destination", destinationDocumentSchema),

    async listEvents(tenantId) {
      const { data, error, status } = await client.rpc("list_content_events", {
        p_tenant_id: tenantId,
      });
      if (error) {
        if (failure(error, status) === "forbidden") return [];
        throw unexpected("Listing events", error);
      }
      return z
        .array(
          z.object({
            content_id: z.uuid(),
            slug: z.string(),
            title: z.string(),
            has_draft: z.boolean(),
            is_published: z.boolean(),
            schedule: eventScheduleSchema.nullable(),
            ended: z.boolean(),
            updated_at: z.string(),
            published_at: z.string().nullable(),
          }),
        )
        .parse(data)
        .map((row) => ({
          contentId: row.content_id,
          slug: row.slug,
          title: row.title,
          status: eventStatus(row.is_published, row.has_draft),
          schedule: row.schedule,
          ended: row.ended,
          updatedAt: row.updated_at,
          publishedAt: row.published_at,
        }));
    },

    createEvent: (tenantId, slug, title) => create(tenantId, "event", slug, title),

    findEvent: (tenantId, contentId) => find(tenantId, contentId, "event", eventDocumentSchema),

    revisionDocument: (tenantId, revisionId) =>
      revision(tenantId, revisionId, destinationDocumentSchema),

    async saveDraft(tenantId, contentId, doc, expectedEdit) {
      const { data, error, status } = await client.rpc("save_content_draft", {
        p_tenant_id: tenantId,
        p_content_id: contentId,
        p_document: doc,
        p_expected_edit: expectedEdit,
      });
      if (error) {
        const kind = failure(error, status);
        if (kind === "invalid") {
          const reason = error.hint === "media" || error.hint === "venue" ? error.hint : "shape";
          return { status: "invalid", reason };
        }
        if (kind === null) throw unexpected("Saving the draft", error);
        return { status: kind };
      }
      const [row] = z
        .array(z.object({ revision_no: z.number().int(), edit_count: z.number().int() }))
        .length(1)
        .parse(data);
      if (!row) throw new Error("Saving the draft returned no row");
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
        if (error.hint === "media") return { status: "invalid", reason: "media" };
        if (kind === "invalid") return { status: "invalid", reason: "incomplete" };
        if (kind === null) throw unexpected("Publishing", error);
        return { status: kind };
      }
      const [row] = z
        .array(z.object({ revision_no: z.number().int() }))
        .length(1)
        .parse(data);
      if (!row) throw new Error("Publishing returned no row");
      return { status: "published", revisionNo: row.revision_no };
    },

    async restore(tenantId, contentId, revisionId) {
      const { data, error, status } = await client.rpc("restore_content_revision", {
        p_tenant_id: tenantId,
        p_content_id: contentId,
        p_revision_id: revisionId,
      });
      if (error) {
        const kind = failure(error, status);
        if (kind === null || kind === "invalid") throw unexpected("Restoring", error);
        return { status: kind };
      }
      const [row] = z
        .array(z.object({ revision_no: z.number().int() }))
        .length(1)
        .parse(data);
      if (!row) throw new Error("Restoring returned no row");
      return { status: "restored", revisionNo: row.revision_no };
    },

    async discardDraft(tenantId, contentId, expectedEdit) {
      const { error, status } = await client.rpc("discard_content_draft", {
        p_tenant_id: tenantId,
        p_content_id: contentId,
        p_expected_edit: expectedEdit,
      });
      if (error) {
        const kind = failure(error, status);
        if (error.hint === "never_published") return { status: "never_published" };
        if (kind === null || kind === "invalid") throw unexpected("Discarding the draft", error);
        return { status: kind };
      }
      return { status: "discarded" };
    },

    async portalHostname(tenantId) {
      const { data, error } = await client.rpc("tenant_portal_host", { p_tenant_id: tenantId });
      if (error) throw unexpected("Reading the portal address", error);
      return z.string().nullable().parse(data);
    },
  };
}

export interface SupabasePublishedContentReaderOptions {
  readonly url: string;
  readonly publishableKey: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

const publicImageSchema = z.object({
  assetId: z.uuid(),
  version: z.number().int(),
  alt: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const point = (latitude: number | null, longitude: number | null) =>
  latitude === null || longitude === null ? null : { lat: latitude, lng: longitude };

export function createSupabasePublishedContentReader(
  options: SupabasePublishedContentReaderOptions,
): PublishedDestinationReader {
  const client = createClient(options.url, options.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
  });
  const timeoutMs = options.timeoutMs ?? 3_000;

  return {
    async list(tenantId) {
      const { data, error } = await client
        .rpc("portal_destinations", { p_tenant_id: tenantId })
        .abortSignal(AbortSignal.timeout(timeoutMs));
      if (error) throw unexpected("Listing published destinations", error);
      return z
        .array(
          z.object({
            slug: z.string(),
            title: z.string(),
            summary: z.string(),
            latitude: z.number().nullable(),
            longitude: z.number().nullable(),
            cover: publicImageSchema.nullable(),
            published_at: z.string(),
            updated_at: z.string(),
          }),
        )
        .parse(data)
        .map((row) => ({
          slug: row.slug,
          title: row.title,
          summary: row.summary,
          location: point(row.latitude, row.longitude),
          cover: row.cover,
          publishedAt: row.published_at,
          updatedAt: row.updated_at,
        }));
    },

    async find(tenantId, slug) {
      const { data, error } = await client
        .rpc("portal_destination", { p_tenant_id: tenantId, p_slug: slug })
        .abortSignal(AbortSignal.timeout(timeoutMs));
      if (error) throw unexpected("Reading a published destination", error);
      const [row] = z
        .array(
          z.object({
            slug: z.string(),
            revision_no: z.number().int(),
            title: z.string(),
            summary: z.string(),
            body: richTextSchema,
            latitude: z.number().nullable(),
            longitude: z.number().nullable(),
            cover: publicImageSchema.nullable(),
            // An image unpublished later would come back null: drop it rather than break.
            gallery: z.array(publicImageSchema.nullable()),
            published_at: z.string(),
            updated_at: z.string(),
          }),
        )
        .max(1)
        .parse(data);
      return row
        ? {
            slug: row.slug,
            revisionNo: row.revision_no,
            title: row.title,
            summary: row.summary,
            body: row.body,
            location: point(row.latitude, row.longitude),
            cover: row.cover,
            gallery: row.gallery.filter((image) => image !== null),
            publishedAt: row.published_at,
            updatedAt: row.updated_at,
          }
        : null;
    },
  };
}

/** Anonymous agenda reads: upcoming events (list) and any published event (find). */
export function createSupabasePublishedEventReader(
  options: SupabasePublishedContentReaderOptions,
): PublishedEventReader {
  const client = createClient(options.url, options.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
  });
  const timeoutMs = options.timeoutMs ?? 3_000;
  const instant = z.string().transform((value) => new Date(value).toISOString());
  const summary = {
    slug: z.string(),
    title: z.string(),
    summary: z.string(),
    schedule: eventScheduleSchema,
    starts_at: instant,
    ends_at: instant,
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    cover: publicImageSchema.nullable(),
    venue: z.object({ slug: z.string(), title: z.string() }).nullable(),
    published_at: z.string(),
    updated_at: z.string(),
  };
  type SummaryRow = z.infer<z.ZodObject<typeof summary>>;
  const toSummary = (row: SummaryRow) => ({
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    schedule: row.schedule,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    location: point(row.latitude, row.longitude),
    cover: row.cover,
    venue: row.venue,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
  });

  return {
    async list(tenantId) {
      const { data, error } = await client
        .rpc("portal_events", { p_tenant_id: tenantId })
        .abortSignal(AbortSignal.timeout(timeoutMs));
      if (error) throw unexpected("Listing upcoming events", error);
      return z.array(z.object(summary)).parse(data).map(toSummary);
    },

    async find(tenantId, slug) {
      const { data, error } = await client
        .rpc("portal_event", { p_tenant_id: tenantId, p_slug: slug })
        .abortSignal(AbortSignal.timeout(timeoutMs));
      if (error) throw unexpected("Reading a published event", error);
      const [row] = z
        .array(
          z.object({
            ...summary,
            revision_no: z.number().int(),
            body: richTextSchema,
            ended: z.boolean(),
            gallery: z.array(publicImageSchema.nullable()),
          }),
        )
        .max(1)
        .parse(data);
      return row
        ? {
            ...toSummary(row),
            revisionNo: row.revision_no,
            body: row.body,
            ended: row.ended,
            gallery: row.gallery.filter((image) => image !== null),
          }
        : null;
    },
  };
}
