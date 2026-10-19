import { buildEventIcs, PORTAL_PATHS } from "@rikuy/core";

import { portalEvent, portalOrigin } from "@/server/portal-content";
import { portalView } from "@/server/portal-view";

/** Resolved per request: these small responses carry their own Cache-Control. */
export const dynamic = "force-dynamic";

interface CalendarContext {
  readonly params: Promise<{ host: string; slug: string }>;
}

/** "Añadir al calendario": the event as an .ics file (works with every calendar app). */
export async function GET(_request: Request, { params }: CalendarContext) {
  const { host, slug } = await params;
  const view = await portalView(host);
  if (view === null) return new Response("Not found", { status: 404 });
  const event = await portalEvent(view, decodeURIComponent(slug));
  if (event === null) return new Response("Not found", { status: 404 });

  const origin = portalOrigin(view);
  const canonicalHost = view.context.tenant.canonicalHost ?? view.context.host;
  const ics = buildEventIcs(event, {
    url: `${origin}${PORTAL_PATHS.event(event.slug)}`,
    uid: `${event.slug}@${canonicalHost}`,
    portalName: view.resolved.presentation.identity.siteName,
  });
  return new Response(ics, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="${event.slug}.ics"`,
      "cache-control": "public, max-age=300",
    },
  });
}
