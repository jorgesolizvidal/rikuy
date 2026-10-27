import "server-only";

import { publishedLogoPath, resolvePortalPresentation } from "@rikuy/core";
import { publicMediaUrl } from "@rikuy/db";
import { cache } from "react";

import { platformSettings, presentationReader } from "./platform";
import { getPortalTenantContext } from "./tenant-context";

/**
 * Everything a portal page needs for one request: the tenant resolved by the proxy, its
 * published presentation and the public URLs of its published logo, if any. Memoized per
 * request (layout, page, metadata and icons share it).
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
        webp: publicMediaUrl(supabaseUrl, publishedLogoPath(tenantId, reference, "logo.webp")),
        png: publicMediaUrl(supabaseUrl, publishedLogoPath(tenantId, reference, "logo.png")),
      }
    : null;
  return { context, resolved, logo };
});

export type PortalView = NonNullable<Awaited<ReturnType<typeof portalView>>>;
