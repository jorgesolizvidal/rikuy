import "server-only";

import { resolvePortalTenant, type TenantContext } from "@rikuy/core";

import { freshTenantDirectory } from "./platform";

/**
 * The tenant of a portal page, from its route host (ADR-015, ADR-024).
 *
 * /portal/{host} is only reachable through the proxy, which rewrites every request to the
 * host it arrived on (an unknown, suspended or alias host never gets here). The page
 * resolves that host again from the registry (uncached) instead of reading a request header,
 * so its HTML can be cached per host by the CDN. A registry outage throws: a cached page
 * keeps being served and nothing is cached as "not found".
 */
export async function getPortalTenantContext(routeHost: string): Promise<TenantContext | null> {
  const resolution = await resolvePortalTenant(
    decodeURIComponent(routeHost),
    freshTenantDirectory(),
  );
  if (resolution.status === "unavailable") throw new Error("Tenant registry unavailable");
  return resolution.status === "found" ? resolution.context : null;
}
