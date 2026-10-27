import { portalTour } from "@/server/portal-content";
import { tourData } from "@/server/portal-tours";
import { portalView } from "@/server/portal-view";

/**
 * One tour's viewer data (JSON), so the general tour jumps to it without leaving the viewer
 * (P4 · Paso 5). The same sealed manifest the tour's page reads, for this portal's
 * municipality only; a tour visitors cannot see is a 404. Short CDN caching: a publication
 * shows within two minutes, like the pages (ADR-024).
 */
export const dynamic = "force-dynamic";

interface TourDataContext {
  readonly params: Promise<{ host: string }>;
}

export async function GET(request: Request, { params }: TourDataContext) {
  const view = await portalView((await params).host);
  if (view === null) return new Response("Not found", { status: 404 });
  const search = new URL(request.url).searchParams;
  const kind = search.get("tipo");
  const slug = search.get("direccion");
  if ((kind !== "destination" && kind !== "event") || !slug || slug.length > 200) {
    return Response.json({ error: "invalid" }, { status: 400 });
  }
  const tour = await portalTour(view, kind, slug);
  if (tour === null) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(tourData(view, tour), {
    headers: { "cache-control": "public, max-age=60, s-maxage=120, stale-while-revalidate=300" },
  });
}
