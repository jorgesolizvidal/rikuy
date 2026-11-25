import {
  openingHoursSchema,
  SERVICE_CATEGORIES,
  serviceDocumentSchema,
  type PublishedService,
  type PublishedServiceReader,
  type ServiceListEntry,
  type ServiceRepository,
  type ServiceStatus,
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
 * The municipality's local services (migration 20261129000100, ADR-069). Items are content of
 * kind "service": the same intent RPCs as destinations, plus retire_content; the portal reads
 * the published ones with portal_services.
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
  service_category: z.enum(SERVICE_CATEGORIES).nullable().catch(null),
});

export function createServiceRepository(client: SessionClient): ServiceRepository {
  const { revision, create, find } = contentAccess(client);
  const content = createContentRepository(client);

  return {
    async list(tenantId) {
      const items = await client
        .from("content_items")
        .select("id, slug, draft_revision_id, published_revision_id, updated_at, published_at")
        .eq("tenant_id", tenantId)
        .eq("kind", "service");
      if (beforeMigration(items.error)) return [];
      if (items.error) throw unexpected("Listing services", items.error);
      const rows = z.array(itemRowSchema).parse(items.data);
      if (rows.length === 0) return [];

      const revisions = await client
        .from("content_revisions")
        .select("id, content_id, revision_no, state, title, service_category")
        .eq("tenant_id", tenantId)
        .in(
          "content_id",
          rows.map((row) => row.id),
        );
      if (beforeMigration(revisions.error)) return [];
      if (revisions.error) throw unexpected("Listing services", revisions.error);
      const all = z.array(revisionRowSchema).parse(revisions.data);

      return rows.map((row): ServiceListEntry => {
        const own = all.filter((entry) => entry.content_id === row.id);
        const shown =
          own.find((entry) => entry.id === row.draft_revision_id) ??
          own.find((entry) => entry.id === row.published_revision_id) ??
          [...own].sort((a, b) => b.revision_no - a.revision_no)[0];
        const sealed = own.some((entry) => entry.state === "sealed");
        const status: ServiceStatus =
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
          category: shown?.service_category ?? null,
          status,
          updatedAt: row.updated_at,
          publishedAt: row.published_at,
        };
      });
    },

    create: (tenantId, slug, title) => create(tenantId, "service", slug, title),

    find: (tenantId, contentId) => find(tenantId, contentId, "service", serviceDocumentSchema),

    revisionDocument: (tenantId, revisionId) =>
      revision(tenantId, revisionId, serviceDocumentSchema),

    async saveDraft(tenantId, contentId, document, expectedEdit) {
      const { data, error, status } = await client.rpc("save_content_draft", {
        p_tenant_id: tenantId,
        p_content_id: contentId,
        p_document: document,
        p_expected_edit: expectedEdit,
      });
      if (error) {
        const kind = failure(error, status);
        if (kind === "invalid") return { status: "invalid" };
        if (kind === null) throw unexpected("Saving the service", error);
        return { status: kind };
      }
      const [row] = z
        .array(z.object({ revision_no: z.number().int(), edit_count: z.number().int() }))
        .length(1)
        .parse(data);
      if (!row) throw new Error("Saving the service returned no row");
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
        if (kind === "invalid") return { status: "invalid" };
        if (kind === null) throw unexpected("Publishing the service", error);
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
        if (kind === null || kind === "invalid") throw unexpected("Retiring the service", error);
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

const portalServiceSchema = z.object({
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  category: z.enum(SERVICE_CATEGORIES),
  hours: openingHoursSchema.nullable().catch(null),
  phone: z.string().nullable(),
  whatsapp: z.string().nullable(),
  address: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
});

export function mapPortalServiceRow(raw: unknown): PublishedService {
  const row = portalServiceSchema.parse(raw);
  return {
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    category: row.category,
    hours: row.hours,
    phone: row.phone,
    whatsapp: row.whatsapp,
    address: row.address,
    location:
      row.latitude !== null && row.longitude !== null
        ? { lat: row.latitude, lng: row.longitude }
        : null,
  };
}

export function createSupabasePublishedServiceReader(
  options: SupabasePublishedContentReaderOptions,
): PublishedServiceReader {
  const client = createClient(options.url, options.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
  });
  const timeoutMs = options.timeoutMs ?? 3_000;
  return {
    async list(tenantId) {
      const { data, error } = await client
        .rpc("portal_services", { p_tenant_id: tenantId })
        .abortSignal(AbortSignal.timeout(timeoutMs));
      // Before the migration (the web app goes first): no services.
      if (isMissingFunction(error)) return [];
      if (error) throw unexpected("Listing the services", error);
      return z.array(z.unknown()).parse(data).map(mapPortalServiceRow);
    },
  };
}
