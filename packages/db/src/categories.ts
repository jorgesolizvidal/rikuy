import type {
  CategoryRepository,
  ContentCategory,
  PortalIndexEntry,
  PublishedContentIndexReader,
  SaveCategoriesOutcome,
} from "@rikuy/core";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { unexpected, type SupabasePublishedContentReaderOptions } from "./content";
import { isMissingFunction } from "./missing-function";
import type { SessionClient } from "./session-client";

/**
 * Categories of the municipality (migration 20261125000000, ADR-062): the panel's
 * repository with the signed-in user's session and the portal's anonymous index.
 */

const categorySchema = z.object({
  id: z.uuid(),
  kind: z.enum(["destination", "event"]),
  name: z.string(),
  position: z.number().int(),
  used: z.number().int(),
});

export function createCategoryRepository(client: SessionClient): CategoryRepository {
  return {
    async list(tenantId): Promise<ContentCategory[]> {
      const { data, error } = await client.rpc("tenant_content_categories", {
        p_tenant_id: tenantId,
      });
      // The web app may be deployed a few minutes before the migration.
      if (isMissingFunction(error)) return [];
      if (error) throw unexpected("Listing the categories", error);
      return z.array(categorySchema).parse(data);
    },

    async save(tenantId, kind, categories): Promise<SaveCategoriesOutcome> {
      const { data, error, status } = await client.rpc("save_content_categories", {
        p_tenant_id: tenantId,
        p_kind: kind,
        p_categories: categories.map((category) =>
          category.id === undefined
            ? { name: category.name }
            : { id: category.id, name: category.name },
        ),
      });
      if (error) {
        if (error.code === "42501" || status === 403) return { status: "forbidden" };
        if (error.code === "23505") return { status: "duplicate", name: "" };
        if (error.code === "23514") return { status: "invalid" };
        throw unexpected("Saving the categories", error);
      }
      return { status: "saved", categories: z.array(categorySchema).parse(data) };
    },
  };
}

const indexRowSchema = z.object({
  kind: z.enum(["destination", "event"]),
  content_id: z.uuid(),
  slug: z.string(),
  category_id: z.uuid().nullable(),
  category_name: z.string().nullable(),
  category_position: z.number().int().nullable(),
});

/** The portal's anonymous index (publishable key; the function checks what is public). */
export function createSupabasePublishedContentIndexReader(
  options: SupabasePublishedContentReaderOptions,
): PublishedContentIndexReader {
  const client = createClient(options.url, options.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
  });
  const timeoutMs = options.timeoutMs ?? 3_000;
  return {
    async index(tenantId): Promise<PortalIndexEntry[]> {
      const { data, error } = await client
        .rpc("portal_content_index", { p_tenant_id: tenantId })
        .abortSignal(AbortSignal.timeout(timeoutMs));
      if (isMissingFunction(error)) return [];
      if (error) throw unexpected("Reading the portal's index", error);
      return z
        .array(indexRowSchema)
        .parse(data)
        .map((row) => ({
          kind: row.kind,
          contentId: row.content_id,
          slug: row.slug,
          category:
            row.category_id === null || row.category_name === null || row.category_position === null
              ? null
              : { id: row.category_id, name: row.category_name, position: row.category_position },
        }));
    },
  };
}
