import { buildSitemap } from "@rikuy/core";

import { portalDestinations, portalOrigin } from "@/server/portal-content";
import { portalView } from "@/server/portal-view";

interface SitemapContext {
  readonly params: Promise<{ host: string }>;
}

/** Per-portal sitemap: only this municipality's published pages, on its canonical host. */
export async function GET(_request: Request, { params }: SitemapContext) {
  const view = await portalView((await params).host);
  if (view === null) return new Response("Not found", { status: 404 });
  const xml = buildSitemap(portalOrigin(view), await portalDestinations(view));
  return new Response(xml, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
