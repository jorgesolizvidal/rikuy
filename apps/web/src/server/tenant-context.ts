import "server-only";

import { decodeTenantContext, type TenantContext } from "@rikuy/core";
import { headers } from "next/headers";

import { TENANT_CONTEXT_HEADER } from "./internal-headers";

/**
 * Returns the tenant context the proxy resolved for this request, or null.
 * The route parameter must match the host the proxy resolved: a mismatch means the
 * request did not come through the proxy as expected, and is treated as not found.
 */
export async function getPortalTenantContext(routeHost: string): Promise<TenantContext | null> {
  const context = decodeTenantContext((await headers()).get(TENANT_CONTEXT_HEADER));
  if (context === null) return null;
  return context.host === decodeURIComponent(routeHost) ? context : null;
}
