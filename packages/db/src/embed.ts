import type {
  EmbedOriginEntry,
  EmbedOriginsOutcome,
  EmbedRepository,
  PlatformEmbedRepository,
  WebLinkOutcome,
} from "@rikuy/core";
import { createClient, type PostgrestError } from "@supabase/supabase-js";
import { z } from "zod";

import type { SupabasePublishedContentReaderOptions } from "./content";
import { isMissingFunction } from "./missing-function";
import type { SessionClient } from "./session-client";

/**
 * «Solo asistente» (migration 20261201000000, ADR-071): the websites where a municipality's
 * assistant may be embedded and «Página en la web del municipio» of each item. The web app
 * can be deployed a few minutes before the migration: until then there are no websites and
 * no links (the editor does not offer the field).
 */

function unexpected(operation: string, error: PostgrestError): Error {
  return new Error(`${operation} failed (${error.code || "unknown"})`);
}

const originsSchema = z.array(z.string());

function originsOutcome(
  data: unknown,
  error: PostgrestError | null,
  operation: string,
): EmbedOriginsOutcome {
  if (!error) return { status: "updated", origins: originsSchema.parse(data) };
  if (error.code === "42501") return { status: "forbidden" };
  if (error.code === "PT404") return { status: "not_found" };
  if (error.code === "PT409") return { status: "too_many" };
  if (error.code === "23514" || error.code === "22P02") return { status: "invalid" };
  throw unexpected(operation, error);
}

/** The operator's side (second factor): list, add and remove a municipality's websites. */
export function createPlatformEmbedRepository(client: SessionClient): PlatformEmbedRepository {
  return {
    async list(tenantId): Promise<EmbedOriginEntry[] | null> {
      const { data, error } = await client.rpc("platform_embed_origins", { p_tenant_id: tenantId });
      if (isMissingFunction(error)) return [];
      if (error?.code === "42501") return null;
      if (error) throw unexpected("Listing the websites", error);
      return z
        .array(z.object({ origin: z.string(), created_at: z.string() }))
        .parse(data)
        .map((row) => ({ origin: row.origin, createdAt: row.created_at }));
    },

    async add(tenantId, origin) {
      const { data, error } = await client.rpc("platform_add_embed_origin", {
        p_tenant_id: tenantId,
        p_origin: origin,
      });
      return originsOutcome(data, error, "Adding a website");
    },

    async remove(tenantId, origin) {
      const { data, error } = await client.rpc("platform_remove_embed_origin", {
        p_tenant_id: tenantId,
        p_origin: origin,
      });
      return originsOutcome(data, error, "Removing a website");
    },
  };
}

/** A member's side: the websites, and the link of each item (owners and admins set it). */
export function createEmbedRepository(client: SessionClient): EmbedRepository {
  return {
    async origins(tenantId) {
      const { data, error } = await client.rpc("tenant_embed_origins", { p_tenant_id: tenantId });
      if (isMissingFunction(error)) return [];
      if (error) throw unexpected("Reading the websites", error);
      return originsSchema.parse(data ?? []);
    },

    async webLink(tenantId, contentId) {
      const { data, error } = await client.rpc("content_web_link", {
        p_tenant_id: tenantId,
        p_content_id: contentId,
      });
      if (isMissingFunction(error)) return null;
      if (error) throw unexpected("Reading the web link", error);
      return z
        .string()
        .nullable()
        .parse(data ?? null);
    },

    async setWebLink(tenantId, contentId, url): Promise<WebLinkOutcome> {
      const { data, error } = await client.rpc("set_content_web_link", {
        p_tenant_id: tenantId,
        p_content_id: contentId,
        p_url: url,
      });
      if (!error)
        return {
          status: "saved",
          url: z
            .string()
            .nullable()
            .parse(data ?? null),
        };
      if (error.code === "42501") return { status: "forbidden" };
      if (error.code === "PT404") return { status: "not_found" };
      if (error.code === "23514") return { status: error.hint === "origin" ? "origin" : "invalid" };
      if (isMissingFunction(error)) return { status: "error" };
      throw unexpected("Saving the web link", error);
    },
  };
}

/** What the assistant links to, anonymous: `kind:slug` → the page on the municipality's website. */
export interface PublishedWebLinkReader {
  links(tenantId: string): Promise<Map<string, string>>;
}

export function createSupabasePublishedWebLinkReader(
  options: SupabasePublishedContentReaderOptions,
): PublishedWebLinkReader {
  const client = createClient(options.url, options.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
  });
  const timeoutMs = options.timeoutMs ?? 3_000;
  return {
    async links(tenantId) {
      const { data, error } = await client
        .rpc("portal_web_links", { p_tenant_id: tenantId })
        .abortSignal(AbortSignal.timeout(timeoutMs));
      if (isMissingFunction(error)) return new Map();
      if (error) throw unexpected("Reading the web links", error);
      const rows = z
        .array(z.object({ kind: z.string(), slug: z.string(), url: z.string() }))
        .parse(data);
      return new Map(rows.map((row) => [`${row.kind}:${row.slug}`, row.url]));
    },
  };
}
