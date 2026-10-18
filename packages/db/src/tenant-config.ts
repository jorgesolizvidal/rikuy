import { createClient, type PostgrestError } from "@supabase/supabase-js";
import type {
  BrandingSnapshot,
  PublishedPresentationReader,
  PublishOutcome,
  SaveDraftOutcome,
  TenantConfigRepository,
} from "@rikuy/core";
import { z } from "zod";

import type { SessionClient } from "./session-client";

/**
 * Tenant configuration adapters (migration 20261017200000).
 *
 * - The repository runs with the signed-in user's JWT: reads are filtered by RLS and the
 *   write RPCs re-check the role in the database. Error codes are mapped to outcomes;
 *   anything unexpected throws (surfaced as "service unavailable").
 * - The published reader is anonymous (publishable key, no session) and can only see the
 *   active sealed version of an active tenant.
 */

const UUID = z.uuid();

const versionRowSchema = z.object({
  id: z.uuid(),
  version: z.number().int(),
  revision: z.number().int(),
  state: z.enum(["draft", "sealed"]),
  branding: z.unknown(),
  sealed_at: z.string().nullable(),
  updated_at: z.string(),
});

const tenantRowSchema = z.object({
  active_config_id: z.uuid().nullable(),
  canonical_domain_id: z.uuid().nullable(),
});

type RpcFailure = "forbidden" | "conflict" | "invalid" | "not_found";

function classify(error: PostgrestError, status: number): RpcFailure | null {
  if (error.code === "42501" || status === 403) return "forbidden";
  if (error.code === "PT409" || status === 409) return "conflict";
  if (error.code === "23514") return "invalid";
  if (error.code === "PT404") return "not_found";
  return null;
}

function unexpected(operation: string, error: PostgrestError): Error {
  return new Error(`${operation} failed (${error.code || "unknown"})`);
}

export function createTenantConfigRepository(client: SessionClient): TenantConfigRepository {
  return {
    async loadSnapshot(tenantId): Promise<BrandingSnapshot> {
      const tenant = await client
        .from("tenants")
        .select("active_config_id, canonical_domain_id")
        .eq("id", tenantId)
        .maybeSingle();
      if (tenant.error) throw unexpected("Reading the tenant", tenant.error);
      if (tenant.data === null) return { published: null, draft: null, portalHostname: null };
      const { active_config_id: activeId, canonical_domain_id: domainId } = tenantRowSchema.parse(
        tenant.data,
      );

      let versionsQuery = client
        .from("tenant_config_versions")
        .select("id, version, revision, state, branding, sealed_at, updated_at")
        .eq("tenant_id", tenantId);
      // UUIDs were validated above, so they are safe inside the filter expression.
      versionsQuery =
        activeId === null
          ? versionsQuery.eq("state", "draft")
          : versionsQuery.or(`state.eq.draft,id.eq.${UUID.parse(activeId)}`);

      const [versions, domain] = await Promise.all([
        versionsQuery,
        domainId === null
          ? Promise.resolve({ data: null, error: null })
          : // Only owners/admins can read the domain registry (RLS); others get null.
            client.from("tenant_domains").select("hostname").eq("id", domainId).maybeSingle(),
      ]);
      if (versions.error) throw unexpected("Reading configuration versions", versions.error);
      if (domain.error) throw unexpected("Reading the canonical domain", domain.error);

      const rows = z.array(versionRowSchema).parse(versions.data);
      const draft = rows.find((row) => row.state === "draft");
      const published = rows.find((row) => row.state === "sealed" && row.id === activeId);
      const hostname = z.object({ hostname: z.string() }).nullable().parse(domain.data)?.hostname;

      return {
        draft: draft
          ? {
              configId: draft.id,
              version: draft.version,
              revision: draft.revision,
              presentation: draft.branding,
              updatedAt: draft.updated_at,
            }
          : null,
        published:
          published && published.sealed_at
            ? {
                configId: published.id,
                version: published.version,
                presentation: published.branding,
                sealedAt: published.sealed_at,
              }
            : null,
        portalHostname: hostname ?? null,
      };
    },

    async saveDraft(tenantId, presentation, expectedRevision): Promise<SaveDraftOutcome> {
      const { data, error, status } = await client.rpc("save_tenant_config_draft", {
        p_tenant_id: tenantId,
        p_branding: presentation,
        p_expected_revision: expectedRevision,
      });
      if (error) {
        const failure = classify(error, status);
        if (failure === null || failure === "not_found")
          throw unexpected("Saving the draft", error);
        return { status: failure };
      }
      const [row] = z
        .array(z.object({ config_id: z.uuid(), version: z.number(), revision: z.number() }))
        .length(1)
        .parse(data);
      if (!row) throw new Error("Saving the draft returned no row");
      return {
        status: "saved",
        configId: row.config_id,
        version: row.version,
        revision: row.revision,
      };
    },

    async publish(tenantId, configId, expectedRevision): Promise<PublishOutcome> {
      const { data, error, status } = await client.rpc("publish_tenant_config", {
        p_tenant_id: tenantId,
        p_config_id: configId,
        p_expected_revision: expectedRevision,
      });
      if (error) {
        const failure = classify(error, status);
        if (failure === null) throw unexpected("Publishing", error);
        return { status: failure };
      }
      const [row] = z
        .array(z.object({ config_id: z.uuid(), version: z.number() }))
        .length(1)
        .parse(data);
      if (!row) throw new Error("Publishing returned no row");
      return { status: "published", configId: row.config_id, version: row.version };
    },
  };
}

export interface SupabasePresentationReaderOptions {
  readonly url: string;
  readonly publishableKey: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

export function createSupabasePresentationReader(
  options: SupabasePresentationReaderOptions,
): PublishedPresentationReader {
  const client = createClient(options.url, options.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
  });
  const timeoutMs = options.timeoutMs ?? 2_000;

  return {
    async findPublished(configId) {
      const { data, error } = await client
        .rpc("get_published_presentation", { p_config_id: configId })
        .abortSignal(AbortSignal.timeout(timeoutMs));
      if (error) throw unexpected("Reading the published presentation", error);
      const rows = z
        .array(z.object({ schema_version: z.number().int(), branding: z.unknown() }))
        .max(1)
        .parse(data);
      const [row] = rows;
      return row ? { schemaVersion: row.schema_version, presentation: row.branding } : null;
    },
  };
}
