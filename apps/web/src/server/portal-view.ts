import "server-only";

import { publishedLogoPath, resolvePortalPresentation } from "@rikuy/core";
import { publicMediaUrl } from "@rikuy/db";
import { cache } from "react";

import { platformSettings, presentationReader, publishedTourReader } from "./platform";
import { getPortalTenantContext } from "./tenant-context";

/**
 * Everything a portal page needs for one request: the tenant resolved by the proxy, its
 * published presentation, the public URLs of its published logo, if any, and its visible
 * tours (the header links the general tour when there are any). Memoized per request
 * (layout, page, metadata and icons share it); the tours are read alongside the brand.
 */
export const portalView = cache(async (routeHost: string) => {
  const context = await getPortalTenantContext(routeHost);
  if (context === null) return null;
  const [resolved, tours] = await Promise.all([
    resolvePortalPresentation(context.tenant, presentationReader()),
    // Without the index the pages still work: no general tour link, that is all.
    publishedTourReader()
      .index(context.tenant.tenantId)
      .catch(() => []),
  ]);
  const reference = resolved.presentation.logo;
  const supabaseUrl = platformSettings().env.NEXT_PUBLIC_SUPABASE_URL;
  const tenantId = context.tenant.tenantId;
  const logo = reference
    ? {
        webp: publicMediaUrl(supabaseUrl, publishedLogoPath(tenantId, reference, "logo.webp")),
        png: publicMediaUrl(supabaseUrl, publishedLogoPath(tenantId, reference, "logo.png")),
      }
    : null;
  return { context, resolved, logo, tours };
});

export type PortalView = NonNullable<Awaited<ReturnType<typeof portalView>>>;
