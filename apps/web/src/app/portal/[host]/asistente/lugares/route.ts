import { portalPlanPlaces } from "@/server/portal-content";
import { portalView } from "@/server/portal-view";

interface PlacesContext {
  readonly params: Promise<{ host: string }>;
}

/**
 * The places a plan of the assistant may include (ADR-039), with their coordinates, so the
 * visitor's phone measures its distance to each one: the position never leaves the device,
 * only rounded distances go with the question. Public data of THIS portal (from the host).
 */
export async function GET(_request: Request, { params }: PlacesContext) {
  const view = await portalView((await params).host);
  if (view === null) return Response.json({ error: "not_found" }, { status: 404 });
  const { destinations, events } = await portalPlanPlaces(view);
  const places = [
    ...destinations.map((place) => ({
      key: `destination:${place.slug}`,
      location: place.location,
    })),
    ...events.map((place) => ({ key: `event:${place.slug}`, location: place.location })),
  ].flatMap(({ key, location }) =>
    location ? [{ key, lat: location.lat, lng: location.lng }] : [],
  );
  return Response.json({ places }, { headers: { "cache-control": "public, max-age=60" } });
}
