import "server-only";

import { portalMediaPath, publishedLogoPath, resolvePortalPresentation } from "@rikuy/core";
import { publicMediaUrl } from "@rikuy/db";
import { cache } from "react";

import { platformSettings, presentationReader } from "./platform";
import { getPortalTenantContext } from "./tenant-context";

/**
 * Everything a portal page needs for one request: the tenant resolved by the proxy, its
 * published presentation and the URLs of its published logo, if any: from the portal's own
 * address for the page (ADR-050), and straight from Storage for the server (the icons read
 * it). Memoized per request (layout, page, metadata and icons share it).
 */
export const portalView = cache(async (routeHost: string) => {
  const context = await getPortalTenantContext(routeHost);
  if (context === null) return null;
  const resolved = await resolvePortalPresentation(context.tenant, presentationReader());
  const reference = resolved.presentation.logo;
  const supabaseUrl = platformSettings().env.NEXT_PUBLIC_SUPABASE_URL;
  const tenantId = context.tenant.tenantId;
  const logo = reference
    ? {
        webp: portalMediaPath(publishedLogoPath(tenantId, reference, "logo.webp")),
        png: portalMediaPath(publishedLogoPath(tenantId, reference, "logo.png")),
        pngFromStorage: publicMediaUrl(
          supabaseUrl,
          publishedLogoPath(tenantId, reference, "logo.png"),
        ),
      }
    : null;
  return { context, resolved, logo };
});

export type PortalView = NonNullable<Awaited<ReturnType<typeof portalView>>>;
