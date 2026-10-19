import { buildRobotsTxt } from "@rikuy/core";

import { portalOrigin } from "@/server/portal-content";
import { portalView } from "@/server/portal-view";

/** Resolved per request: these small responses carry their own Cache-Control. */
export const dynamic = "force-dynamic";

interface RobotsContext {
  readonly params: Promise<{ host: string }>;
}

/** Per-portal robots.txt pointing at its own sitemap. */
export async function GET(_request: Request, { params }: RobotsContext) {
  const view = await portalView((await params).host);
  if (view === null) return new Response("Not found", { status: 404 });
  return new Response(buildRobotsTxt(portalOrigin(view)), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
