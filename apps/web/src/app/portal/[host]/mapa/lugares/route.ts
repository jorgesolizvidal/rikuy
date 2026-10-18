import { parseBoundingBox } from "@rikuy/core";

import { publishedMapReader } from "@/server/platform";
import { toMapPoint } from "@/server/portal-content";
import { portalView } from "@/server/portal-view";

interface PlacesContext {
  readonly params: Promise<{ host: string }>;
}

/**
 * Places of THIS portal inside `?area=west,south,east,north` (the map's current view).
 * The tenant comes from the host, never from the query; areas larger than 20° are refused.
 */
export async function GET(request: Request, { params }: PlacesContext) {
  const view = await portalView((await params).host);
  if (view === null) return Response.json({ error: "not_found" }, { status: 404 });
  const area = parseBoundingBox(new URL(request.url).searchParams.get("area"));
  if (area === null) return Response.json({ error: "invalid_area" }, { status: 400 });

  const places = await publishedMapReader().places(view.context.tenant.tenantId, area, [
    "destination",
    "event",
  ]);
  return Response.json(
    { places: places.map(toMapPoint) },
    { headers: { "cache-control": "public, max-age=30" } },
  );
}
