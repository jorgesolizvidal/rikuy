import type { PortalTenant, TenantContext } from "../../contracts/tenant";

/** Port: the domain registry. Implemented by @rikuy/db. */
export interface TenantDirectory {
  /** Exact lookup of a normalized hostname. Resolves null when unknown or inactive. */
  findByHost(hostname: string): Promise<PortalTenant | null>;
}

/** Raised by adapters when the registry cannot be consulted (network, timeout, 5xx). */
export class TenantDirectoryUnavailableError extends Error {
  constructor(message = "Tenant directory unavailable", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TenantDirectoryUnavailableError";
  }
}

export type PortalResolution =
  | { readonly status: "found"; readonly context: TenantContext }
  | { readonly status: "redirect"; readonly canonicalHost: string }
  | { readonly status: "not_found" }
  | { readonly status: "unavailable" };

/**
 * Use case: which tenant does this portal host belong to?
 * - registered alias of a tenant with a different canonical host → redirect;
 * - unknown, inactive or suspended → not_found (there is no default tenant);
 * - registry unreachable → unavailable (never guess).
 */
export async function resolvePortalTenant(
  hostname: string,
  directory: TenantDirectory,
): Promise<PortalResolution> {
  let tenant: PortalTenant | null;
  try {
    tenant = await directory.findByHost(hostname);
  } catch {
    return { status: "unavailable" };
  }

  if (tenant === null) return { status: "not_found" };

  if (!tenant.isCanonical && tenant.canonicalHost !== null && tenant.canonicalHost !== hostname) {
    return { status: "redirect", canonicalHost: tenant.canonicalHost };
  }

  return { status: "found", context: { version: 1, host: hostname, tenant } };
}
