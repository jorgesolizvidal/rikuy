import "server-only";

import {
  formatEventSchedule,
  imageCandidates,
  mapPlacePath,
  PORTAL_PATHS,
  type PortalMapPlace,
  type PublishedImage,
} from "@rikuy/core";
import { publicMediaUrl } from "@rikuy/db";
import { cache } from "react";

import {
  platformSettings,
  publishedContentReader,
  publishedEventReader,
  publishedMapReader,
} from "./platform";
import type { NearbyTargetDto } from "@/app/portal/[host]/visitor-location";

import type { PortalView } from "./portal-view";

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
