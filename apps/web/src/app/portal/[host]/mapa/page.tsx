import {
  MAP_ROUTE_MAX,
  MAP_ROUTE_QUERY,
  MAX_AREA_SPAN_DEGREES,
  nearbyRadiusOf,
  PORTAL_PATHS,
  padBoundingBox,
  type BoundingBox,
} from "@rikuy/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { publishedMapReader } from "@/server/platform";
import { portalMapExtent, toMapPoint } from "@/server/portal-content";
import { portalView } from "@/server/portal-view";

import { MapExplorer } from "../map-explorer";
import { MapRoute } from "../map-route";
import { MapMeasureLoader } from "../map-measure-loader";

/** `?lat=…&lng=…` and `?ruta=…` change the page: rendered per request (not cached, ADR-024). */
export const dynamic = "force-dynamic";

interface MapPageProps {
  readonly params: Promise<{ host: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({
  params,
}: Omit<MapPageProps, "searchParams">): Promise<Metadata> {
  const view = await portalView((await params).host);
  if (view === null) return {};
  const { siteName } = view.resolved.presentation.identity;
  const description = `Mapa de ${siteName}: destinos y eventos próximos, con la lista de lugares.`;
  return {
    title: "Mapa",
    description,
    alternates: { canonical: PORTAL_PATHS.map },
    openGraph: { title: `Mapa | ${siteName}`, description },
  };
}

/** `?lat=…&lng=…` (from a page's mini map) centers the map there. */
function requestedCenter(query: Record<string, string | string[] | undefined>) {
  const number = (value: unknown, min: number, max: number) => {
    if (typeof value !== "string" || !/^-?\d{1,3}(\.\d{1,7})?$/u.test(value)) return null;
    const n = Number(value);
    return n >= min && n <= max ? n : null;
  };
  const lat = number(query.lat, -90, 90);
  const lng = number(query.lng, -180, 180);
  return lat === null || lng === null ? null : { lat, lng, zoom: 15 };
}

/** `?ruta=destination:plaza,event:feria` (a plan of the assistant): place keys, in order. */
function requestedRoute(query: Record<string, string | string[] | undefined>): string[] {
  const value = query[MAP_ROUTE_QUERY];
  if (typeof value !== "string") return [];
  const keys = value
    .split(",")
    .filter((key) => /^(?:destination|event):[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(key));
  return [...new Set(keys)].slice(0, MAP_ROUTE_MAX);
}

function capped(box: BoundingBox): BoundingBox {
  const half = MAX_AREA_SPAN_DEGREES / 2;
  const cx = (box.west + box.east) / 2;
  const cy = (box.south + box.north) / 2;
  return {
    west: Math.max(-180, Math.max(box.west, cx - half)),
    east: Math.min(180, Math.min(box.east, cx + half)),
    south: Math.max(-90, Math.max(box.south, cy - half)),
    north: Math.min(90, Math.min(box.north, cy + half)),
  };
}

export default async function MapPage({ params, searchParams }: MapPageProps) {
  const view = await portalView((await params).host);
  if (view === null) notFound();
  const [extent, query] = await Promise.all([portalMapExtent(view), searchParams]);
  const center = requestedCenter(query);
  const routeKeys = requestedRoute(query);
  const { siteName } = view.resolved.presentation.identity;

  const area = extent.bounds
    ? capped(padBoundingBox(extent.bounds))
    : center
      ? padBoundingBox({ west: center.lng, south: center.lat, east: center.lng, north: center.lat })
      : null;
  const places = area
    ? await publishedMapReader().places(view.context.tenant.tenantId, area, [
        "destination",
        "event",
      ])
    : [];

  // The stops that are still on the map (an event that ended meanwhile is not), in order.
  const byKey = new Map(places.map((place) => [`${place.kind}:${place.slug}`, place]));
  const route = routeKeys
    .flatMap((key) => {
      const place = byKey.get(key);
      return place ? [{ ...toMapPoint(place), order: 0 }] : [];
    })
    .map((point, index) => ({ ...point, order: index + 1 }));
  const routeArea =
    route.length > 0
      ? padBoundingBox({
          west: Math.min(...route.map((point) => point.lng)),
          south: Math.min(...route.map((point) => point.lat)),
          east: Math.max(...route.map((point) => point.lng)),
          north: Math.max(...route.map((point) => point.lat)),
        })
      : null;

  return (
    <div className="portal-page portal-map-page">
      <nav aria-label="Ruta de navegación" className="portal-breadcrumb">
        <ol>
          <li>
            <a href="/">Inicio</a>
          </li>
          <li aria-current="page">Mapa</li>
        </ol>
      </nav>
      <h1 className="portal-page-title">Mapa</h1>
      {route.length > 0 ? (
        <p className="portal-lead">
          La ruta que te sugirió el asistente por {siteName}, con sus paradas en orden.
        </p>
      ) : (
        <p className="portal-lead">
          Destinos y eventos próximos de {siteName}. Mueve el mapa para ver otra zona; la lista
          muestra los mismos lugares. Con «Usar mi ubicación» verás dónde estás y qué tienes cerca;
          tu ubicación no sale de tu dispositivo.
        </p>
      )}
      {route.length > 0 && routeArea ? (
        <MapRoute stops={route} area={routeArea} />
      ) : area === null ? (
        <p className="portal-empty">Todavía no hay lugares en el mapa.</p>
      ) : (
        <MapExplorer
          initialPoints={places.map(toMapPoint)}
          initialArea={area}
          complete={places.length >= extent.destinations + extent.events}
          nearbyRadius={nearbyRadiusOf(view.resolved.presentation)}
          {...(center ? { center } : {})}
        />
      )}
      <MapMeasureLoader />
    </div>
  );
}
