import { createClient } from "@supabase/supabase-js";
import {
  TenantDirectoryUnavailableError,
  type PortalTenant,
  type TenantDirectory,
} from "@rikuy/core";
import { z } from "zod";

/**
 * Domain-registry adapter backed by `public.resolve_tenant_by_host` (migration P1).
 *
 * Uses the PUBLISHABLE key only: the function is the single anonymous entry point and
 * exposes no private data. The client keeps no session (no user identity is involved),
 * so sharing one instance across requests cannot leak an identity between users.
 */

const rowSchema = z.object({
  tenant_id: z.uuid(),
  tenant_slug: z.string(),
  display_name: z.string(),
  default_locale: z.string(),
  timezone: z.string(),
  canonical_host: z.string().nullable(),
  is_canonical: z.boolean(),
  active_config_id: z.uuid().nullable(),
});

export function mapTenantRow(row: unknown): PortalTenant {
  const r = rowSchema.parse(row);
  return {
    tenantId: r.tenant_id,
    slug: r.tenant_slug,
    displayName: r.display_name,
    defaultLocale: r.default_locale,
    timezone: r.timezone,
    canonicalHost: r.canonical_host,
    isCanonical: r.is_canonical,
    activeConfigId: r.active_config_id,
  };
}

export interface SupabaseTenantDirectoryOptions {
  readonly url: string;
  readonly publishableKey: string;
  /** Hard deadline for one lookup; a slow registry must surface as 503, not hang. */
  readonly timeoutMs?: number;
  /** Injectable for tests. */
  readonly fetch?: typeof fetch;
}

export function createSupabaseTenantDirectory(
  options: SupabaseTenantDirectoryOptions,
): TenantDirectory {
  const client = createClient(options.url, options.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
  });
  const timeoutMs = options.timeoutMs ?? 2_000;

  return {
    async findByHost(hostname) {
      let response;
      try {
        response = await client
          .rpc("resolve_tenant_by_host", { p_host: hostname })
          .abortSignal(AbortSignal.timeout(timeoutMs));
      } catch (cause) {
        throw new TenantDirectoryUnavailableError("Tenant registry request failed", { cause });
      }

      if (response.error) {
        throw new TenantDirectoryUnavailableError(
          `Tenant registry error: ${response.error.code ?? "unknown"}`,
        );
      }

      const rows: unknown[] = Array.isArray(response.data) ? response.data : [];
      const [first] = rows;
      if (rows.length > 1) {
        // A hostname is globally unique; more than one row means the contract broke.
        throw new TenantDirectoryUnavailableError(
          "Tenant registry returned more than one tenant for a host",
        );
      }
      return first === undefined ? null : mapTenantRow(first);
    },
  };
}
