import "server-only";

import {
  formatEventSchedule,
  imageCandidates,
  loadAssistantPlaces,
  mapPlacePath,
  PORTAL_PATHS,
  type PortalMapPlace,
  type PublishedImage,
} from "@rikuy/core";
import { publicMediaUrl } from "@rikuy/db";
import { notFound, permanentRedirect } from "next/navigation";
import { cache } from "react";

import {
  platformSettings,
  publishedContentReader,
  publishedEventReader,
  publishedMapReader,
  publishedRedirectReader,
  publishedTourReader,
} from "./platform";
import type { NearbyTargetDto } from "@/app/portal/[host]/visitor-location";

import { portalView, type PortalView } from "./portal-view";

/** What an <img> needs to load the right derivative and reserve its space. */
export interface ResponsiveImage {
  readonly src: string;
  readonly srcSet: string;
  readonly width: number;
  readonly height: number;
  readonly alt: string;
  /** Largest derivative (Open Graph, "ver en tamaño completo"). */
  readonly largest: { readonly url: string; readonly width: number; readonly height: number };
}

export function responsiveImage(tenantId: string, image: PublishedImage): ResponsiveImage {
  const supabaseUrl = platformSettings().env.NEXT_PUBLIC_SUPABASE_URL;
  const candidates = imageCandidates(tenantId, image).map((candidate) => ({
    ...candidate,
    url: publicMediaUrl(supabaseUrl, candidate.path),
  }));
  const middle = candidates[Math.min(1, candidates.length - 1)];
  const largest = candidates.at(-1);
  if (!middle || !largest) throw new Error("An image has at least one derivative");
  return {
    src: middle.url,
    srcSet: candidates.map((candidate) => `${candidate.url} ${candidate.width}w`).join(", "),
    width: largest.width,
    height: largest.height,
    alt: image.alt,
    largest: { url: largest.url, width: largest.width, height: largest.height },
  };
}

/** Published destinations of the portal's tenant (memoized per request). */
export const portalDestinations = cache(async (view: PortalView) =>
  publishedContentReader().list(view.context.tenant.tenantId),
);

/** One published destination, or null (unknown slug, draft only, other tenant). */
export const portalDestination = cache(async (view: PortalView, slug: string) =>
  publishedContentReader().find(view.context.tenant.tenantId, slug),
);

/** Opening hours of the published destinations that have them, by slug (ADR-039). */
export const portalOpeningHours = cache(async (view: PortalView) =>
  publishedContentReader().openingHours(view.context.tenant.tenantId),
);

/** What a plan of the assistant may include: destinations with hours and upcoming events. */
export const portalPlanPlaces = cache(async (view: PortalView) =>
  loadAssistantPlaces(view.context.tenant.tenantId, {
    destinations: publishedContentReader(),
    events: publishedEventReader(),
  }),
);

/** Absolute public origin of this portal (its canonical host). */
export function portalOrigin(view: PortalView): string {
  return platformSettings().portalOrigin(view.context.tenant.canonicalHost ?? view.context.host);
}

/** Destinations with a location, for «Estás cerca de…» (decided in the browser). */
export const portalNearbyTargets = cache(async (view: PortalView): Promise<NearbyTargetDto[]> =>
  (await portalDestinations(view)).flatMap((destination) =>
    destination.location
      ? [
          {
            key: destination.slug,
            title: destination.title,
            href: PORTAL_PATHS.destination(destination.slug),
            lat: destination.location.lat,
            lng: destination.location.lng,
          },
        ]
      : [],
  ),
);

/** Upcoming and ongoing events of the portal's tenant, soonest first. */
export const portalEvents = cache(async (view: PortalView) =>
  publishedEventReader().list(view.context.tenant.tenantId),
);

/** One published event (also after it ended), or null. */
export const portalEvent = cache(async (view: PortalView, slug: string) =>
  publishedEventReader().find(view.context.tenant.tenantId, slug),
);

/** What the browser map and its list need for one place (no internal ids). */
export interface MapPointDto {
  readonly key: string;
  readonly kind: "destination" | "event";
  readonly title: string;
  readonly href: string;
  /** Event date, or the destination's summary. */
  readonly detail: string;
  readonly lat: number;
  readonly lng: number;
  /** Its number in a route of the assistant (`/mapa?ruta=…`, ADR-039). */
  readonly order?: number;
}

export function toMapPoint(place: PortalMapPlace): MapPointDto {
  return {
    key: `${place.kind}:${place.slug}`,
    kind: place.kind,
    title: place.title,
    href: mapPlacePath(place),
    detail: place.schedule ? formatEventSchedule(place.schedule) : place.summary,
    lat: place.location.lat,
    lng: place.location.lng,
  };
}

export const portalMapExtent = cache(async (view: PortalView) =>
  publishedMapReader().extent(view.context.tenant.tenantId),
);

/**
 * A portal with nothing to visit yet: no published destination and no event still to come
 * (the map's extent counts both). A new municipality goes online before its team loads the
 * content; until then search engines are asked not to index it (Hito · Paso 1). On an error
 * the portal counts as not empty: a hiccup never removes a real portal from search engines.
 */
export const portalIsEmpty = cache(async (view: PortalView) =>
  portalMapExtent(view).then(
    (extent) => extent.destinations === 0 && extent.events === 0,
    () => false,
  ),
);

/** The published tour of a destination or event (also of an ended event), or null. */
export const portalTour = cache(
  async (view: PortalView, kind: "destination" | "event", slug: string) =>
    publishedTourReader().find(view.context.tenant.tenantId, kind, slug),
);

/**
 * The tours a visitor can browse, in the general tour's order (memoized per request: the
 * layout's header link and the tour pages share it). Pages only, never the icons or the
 * manifest. Without it a page still works: no general tour link, that is all.
 */
export const portalTourIndex = cache(async (view: PortalView) =>
  publishedTourReader()
    .index(view.context.tenant.tenantId)
    .catch(() => []),
);

/**
 * Whether a destination or event has a tour visitors can open, for its page's link. From the
 * index the layout already reads (no extra query); an ended event is not in the index, so
 * only then its tour is looked up.
 */
export async function portalHasTour(
  view: PortalView,
  kind: "destination" | "event",
  slug: string,
  ended = false,
): Promise<boolean> {
  if (ended) return (await portalTour(view, kind, slug)) !== null;
  return (await portalTourIndex(view)).some((entry) => entry.kind === kind && entry.slug === slug);
}

/**
 * The current address of an old one (ADR-047), or null. Only pages whose address is not
 * found ask; the answer is cached with the page.
 */
export async function portalMovedSlug(
  view: PortalView,
  kind: "destination" | "event",
  slug: string,
): Promise<string | null> {
  return publishedRedirectReader().currentSlug(view.context.tenant.tenantId, kind, slug);
}

/**
 * For a page whose address was not found: an old address of a destination or event answers
 * 308 to its current page (old links and printed QR codes keep working); anything else is
 * the portal's 404.
 */
export async function movedOrNotFound(
  params: Promise<{ readonly host: string; readonly slug: string }>,
  kind: "destination" | "event",
  to: (slug: string) => string,
): Promise<never> {
  const { host, slug } = await params;
  const view = await portalView(host);
  const current = view ? await portalMovedSlug(view, kind, decodeURIComponent(slug)) : null;
  if (current) permanentRedirect(to(current));
  notFound();
}
