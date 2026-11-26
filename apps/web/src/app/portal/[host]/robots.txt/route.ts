import { buildRobotsTxt } from "@rikuy/core";

import { portalOrigin } from "@/server/portal-content";
import { portalHas, portalView } from "@/server/portal-view";

/** Resolved per request: these small responses carry their own Cache-Control. */
export const dynamic = "force-dynamic";

interface RobotsContext {
  readonly params: Promise<{ host: string }>;
}

/** Per-portal robots.txt pointing at its own sitemap. */
export async function GET(_request: Request, { params }: RobotsContext) {
  const view = await portalView((await params).host);
  if (view === null) return new Response("Not found", { status: 404 });
  // Without its public portal (ADR-071) there is nothing to index: only the assistant's pages.
  const body = portalHas(view, "portal")
    ? buildRobotsTxt(portalOrigin(view))
    : "User-agent: *\nDisallow: /\n";
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
