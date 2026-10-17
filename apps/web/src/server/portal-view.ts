import "server-only";

import { resolvePortalPresentation } from "@rikuy/core";
import { cache } from "react";

import { presentationReader } from "./platform";
import { getPortalTenantContext } from "./tenant-context";

/**
 * Everything a portal page needs for one request: the tenant resolved by the proxy and
 * its published presentation. Memoized per request (layout, page and metadata share it).
 */
export const portalView = cache(async (routeHost: string) => {
  const context = await getPortalTenantContext(routeHost);
  if (context === null) return null;
  const resolved = await resolvePortalPresentation(context.tenant, presentationReader());
  return { context, resolved };
});

export type PortalView = NonNullable<Awaited<ReturnType<typeof portalView>>>;
