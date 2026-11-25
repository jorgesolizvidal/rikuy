import "server-only";

import {
  categoryBySlug,
  formatEventSchedule,
  heroCandidates,
  imageCandidates,
  loadAssistantPlaces,
  nearestPlaces,
  noticesInForce,
  mapPlacePath,
  PORTAL_PATHS,
  portalMediaPath,
  SERVICE_CATEGORY_INFO,
  tourPath,
  type GeoPoint,
  type PortalCircuit,
  type PortalIndexEntry,
  type PortalMapPlace,
  type PublishedNotice,
  type PublishedService,
  type ServiceCategory,
  type PublishedEventSummary,
  type PublishedImage,
} from "@rikuy/core";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { cache } from "react";

import {
  platformSettings,
  publishedContentReader,
  publishedEventReader,
  publishedIndexReader,
  publishedMapReader,
  publishedNoticeReader,
  publishedPassportReader,
  publishedServiceReader,
  publishedRedirectReader,
  publishedTourReader,
  publishedTourRedirectReader,
} from "./platform";
import type { NoticeDto } from "@/app/portal/[host]/notice-strip";
import type { NearbyTargetDto } from "@/app/portal/[host]/visitor-location";

import { portalHas, portalView, type PortalView } from "./portal-view";

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

/** Photos are served from the portal's own address (ADR-050): relative URLs. */
export function responsiveImage(tenantId: string, image: PublishedImage): ResponsiveImage {
  return toResponsive(image, imageCandidates(tenantId, image));
}

/** The home cover: its lighter hero versions when they are public (ADR-070). */
export function heroImage(tenantId: string, image: PublishedImage): ResponsiveImage {
  return toResponsive(image, heroCandidates(tenantId, image));
}

function toResponsive(
  image: PublishedImage,
  found: readonly { readonly path: string; readonly width: number; readonly height: number }[],
): ResponsiveImage {
  const candidates = found.map((candidate) => ({
    ...candidate,
    url: portalMediaPath(candidate.path),
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

/**
 * The municipality's notices in force or starting within a day (ADR-069). Without them the
 * page still shows: a failure here means no strip, never an error page.
 */
export const portalNotices = cache(async (view: PortalView): Promise<readonly PublishedNotice[]> =>
  publishedNoticeReader()
    .list(view.context.tenant.tenantId)
    .catch(() => []),
);

/**
 * The municipality's published local services (ADR-069), none when it does not have the
 * module. A failure means an empty list, never an error page.
 */
export const portalServices = cache(
  async (view: PortalView): Promise<readonly PublishedService[]> =>
    portalHas(view, "services")
      ? publishedServiceReader()
          .list(view.context.tenant.tenantId)
          .catch(() => [])
      : [],
);

export function noticeDto(notice: PublishedNotice): NoticeDto {
  return {
    slug: notice.slug,
    title: notice.title,
    summary: notice.summary,
    startsAt: notice.startsAt,
    endsAt: notice.endsAt,
    href: PORTAL_PATHS.notice(notice.slug),
    place: notice.place
      ? {
          ...notice.place,
          href:
            notice.place.kind === "destination"
              ? PORTAL_PATHS.destination(notice.place.slug)
              : PORTAL_PATHS.event(notice.place.slug),
        }
      : null,
  };
}

/** The notices for the browser, and the ones in force when the page is built. */
export interface NoticeView {
  readonly notices: readonly NoticeDto[];
  readonly initial: readonly string[];
}

function noticeView(notices: readonly PublishedNotice[]): NoticeView {
  return {
    notices: notices.map(noticeDto),
    initial: noticesInForce(notices, new Date()).map((notice) => notice.slug),
  };
}

/** Every notice, for the strip and /avisos. */
export async function portalNoticeView(view: PortalView): Promise<NoticeView> {
  return noticeView(await portalNotices(view));
}

/** The notices about one place, for its page. */
export async function placeNoticeView(
  view: PortalView,
  kind: "destination" | "event",
  slug: string,
): Promise<NoticeView> {
  const notices = await portalNotices(view);
  return noticeView(
    notices.filter((notice) => notice.place?.kind === kind && notice.place.slug === slug),
  );
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
export const portalPlanPlaces = cache(async (view: PortalView) => {
  const places = await loadAssistantPlaces(view.context.tenant.tenantId, {
    destinations: publishedContentReader(),
    events: publishedEventReader(),
  });
  // Without the agenda, no plan includes events (ADR-060).
  return portalHas(view, "agenda") ? places : { ...places, events: [] };
});

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

/**
 * Upcoming and ongoing events of the portal's tenant, soonest first. None without the agenda
 * (ADR-060): every page that lists events reads them here.
 */
export const portalEvents = cache(async (view: PortalView) =>
  portalHas(view, "agenda") ? publishedEventReader().list(view.context.tenant.tenantId) : [],
);

/** One published event (also after it ended), or null; null without the agenda. */
export const portalEvent = cache(async (view: PortalView, slug: string) =>
  portalHas(view, "agenda")
    ? publishedEventReader().find(view.context.tenant.tenantId, slug)
    : null,
);

/** What the browser map and its list need for one place (no internal ids). */
export interface MapPointDto {
  readonly key: string;
  readonly kind: "destination" | "event" | "service";
  readonly title: string;
  readonly href: string;
  /** Event date, or the destination's summary. */
  readonly detail: string;
  readonly lat: number;
  readonly lng: number;
  /** Its number in a route of the assistant (`/mapa?ruta=…`, ADR-039). */
  readonly order?: number;
  /** The municipality's category (ADR-062), for the map's filter (C3 · Paso 4). */
  readonly category?: string | null;
  /** The smallest derivative of its cover, for the list (decorative: the title is beside it). */
  readonly thumb?: string | null;
  /** A local service's category (ADR-069): the icon of its pin. */
  readonly service?: ServiceCategory;
}

/** A local service with a location as a point of the map's «Servicios» layer (ADR-069). */
export function serviceMapPoint(service: PublishedService): MapPointDto | null {
  if (!service.location) return null;
  return {
    key: `service:${service.slug}`,
    kind: "service",
    title: service.title,
    href: PORTAL_PATHS.service(service.slug),
    detail: SERVICE_CATEGORY_INFO[service.category].name,
    lat: service.location.lat,
    lng: service.location.lng,
    category: null,
    thumb: null,
    service: service.category,
  };
}

/** The categories of what is published, by `kind:slug` (for the map's points). */
export function categoriesByKey(index: readonly PortalIndexEntry[]): ReadonlyMap<string, string> {
  return new Map(
    (["destination", "event"] as const).flatMap((kind) =>
      [...categoryBySlug(index, kind)].map(([slug, category]) => [
        `${kind}:${slug}`,
        category.name,
      ]),
    ),
  );
}

/** The smallest derivative of a photo, from the portal's own address (ADR-050). */
export function thumbnailOf(tenantId: string, image: PublishedImage | null): string | null {
  const smallest = image ? imageCandidates(tenantId, image)[0] : undefined;
  return smallest ? portalMediaPath(smallest.path) : null;
}

export function toMapPoint(
  place: PortalMapPlace,
  extras?: { readonly tenantId: string; readonly categories: ReadonlyMap<string, string> },
): MapPointDto {
  const key = `${place.kind}:${place.slug}`;
  return {
    key,
    kind: place.kind,
    title: place.title,
    href: mapPlacePath(place),
    detail: place.schedule ? formatEventSchedule(place.schedule) : place.summary,
    lat: place.location.lat,
    lng: place.location.lng,
    ...(extras
      ? {
          category: extras.categories.get(key) ?? null,
          thumb: thumbnailOf(extras.tenantId, place.cover),
        }
      : {}),
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

/**
 * The tourist passport's published circuits (ADR-056), memoized per request: the layout's
 * header link and the passport pages share it. Without it a page still works.
 */
export const portalPassport = cache(async (view: PortalView) =>
  portalHas(view, "passport")
    ? publishedPassportReader()
        .circuits(view.context.tenant.tenantId)
        .catch(() => [])
    : [],
);

/**
 * Ids, addresses and categories of what is published (ADR-062), memoized per request. A
 * failure leaves the filters and the chosen cover out; the page still renders.
 */
export const portalIndex = cache(async (view: PortalView) =>
  publishedIndexReader()
    .index(view.context.tenant.tenantId)
    .catch(() => []),
);

/**
 * What the cards say about each place besides its own data: it has a 360° tour, or it is a
 * stop of a published circuit (its stamp). Keys are `destination:slug` and `event:slug`.
 */
export const portalBadges = cache(async (view: PortalView) => {
  const [tours, circuits] = await Promise.all([portalTourIndex(view), portalPassport(view)]);
  return {
    tours: new Set(tours.map((entry) => `${entry.kind}:${entry.slug}`)),
    stamps: new Set(
      circuits.flatMap((circuit) => circuit.stops.map((stop) => `destination:${stop.slug}`)),
    ),
  };
});

/** The published tour of a destination or event (also of an ended event), or null. */
export const portalTour = cache(
  async (view: PortalView, kind: "destination" | "event", slug: string) =>
    portalHas(view, "tours") && (kind === "destination" || portalHas(view, "agenda"))
      ? publishedTourReader().find(view.context.tenant.tenantId, kind, slug)
      : null,
);

/**
 * The tours a visitor can browse, in the general tour's order (memoized per request: the
 * layout's header link and the tour pages share it). Pages only, never the icons or the
 * manifest. Without it a page still works: no general tour link, that is all.
 */
export const portalTourIndex = cache(async (view: PortalView) =>
  portalHas(view, "tours")
    ? publishedTourReader()
        .index(view.context.tenant.tenantId)
        .then((index) =>
          // Without the agenda, no tour of an event either (ADR-060).
          portalHas(view, "agenda") ? index : index.filter((entry) => entry.kind !== "event"),
        )
        .catch(() => [])
    : [],
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

/**
 * For a tour page that is not found: an old address of its place answers 308 to the tour at
 * the current one (ADR-047); a tour that moved leads to its new page, and a place without a
 * tour to its own page (ADR-049). These two are temporary (307): the place can get a tour
 * again. Anything else is the portal's 404.
 */
export async function tourMovedOrNotFound(
  params: Promise<{ readonly host: string; readonly slug: string }>,
  kind: "destination" | "event",
): Promise<never> {
  const { host, slug } = await params;
  const view = await portalView(host);
  if (!view) notFound();
  const decoded = decodeURIComponent(slug);
  // Without the tours (ADR-060), a link to one leads to the place's own page.
  if (!portalHas(view, "tours")) {
    redirect(kind === "event" ? PORTAL_PATHS.event(decoded) : PORTAL_PATHS.destination(decoded));
  }
  const current = await portalMovedSlug(view, kind, decoded);
  if (current) permanentRedirect(tourPath(kind, current));
  const moved = await publishedTourRedirectReader().find(
    view.context.tenant.tenantId,
    kind,
    decoded,
  );
  if (moved?.target === "tour") redirect(tourPath(moved.kind, moved.slug));
  if (moved?.target === "place") {
    redirect(
      moved.kind === "event"
        ? PORTAL_PATHS.event(moved.slug)
        : PORTAL_PATHS.destination(moved.slug),
    );
  }
  notFound();
}

/** A place in «Cerca de aquí» (ADR-063): straight-line meters from the page's place. */
export interface NearbyPlaceDto {
  readonly key: string;
  readonly kind: "destination" | "event";
  readonly title: string;
  readonly href: string;
  /** The event's date, or the destination's category. */
  readonly detail: string | null;
  readonly meters: number;
  readonly cover: PublishedImage | null;
}

/** What a destination's or an event's page shows besides the place itself (ADR-063). */
export interface PlaceExtras {
  /** Its category (ADR-062), for the cover. */
  readonly category: string | null;
  /** The published circuits it is a stop of (destinations only): its stamp. */
  readonly circuits: readonly Pick<PortalCircuit, "slug" | "name">[];
  /** Upcoming events at this destination (none for an event). */
  readonly eventsHere: readonly PublishedEventSummary[];
  readonly nearby: readonly NearbyPlaceDto[];
}

/**
 * From reads the page already shares with the layout (destinations, events, index, passport):
 * no extra query per page. Any failure leaves a section out; the page still renders.
 */
export async function portalPlaceExtras(
  view: PortalView,
  here: {
    readonly kind: "destination" | "event";
    readonly slug: string;
    readonly location: GeoPoint | null;
    /** An event's venue: already linked on its page, so not «cerca» again. */
    readonly venue?: string | null;
  },
): Promise<PlaceExtras> {
  const [destinations, events, index, circuits] = await Promise.all([
    portalDestinations(view).catch(() => []),
    portalEvents(view).catch(() => []),
    portalIndex(view),
    here.kind === "destination" ? portalPassport(view) : Promise.resolve([]),
  ]);
  const categories = categoriesByKey(index);
  const eventsHere =
    here.kind === "destination" ? events.filter((event) => event.venue?.slug === here.slug) : [];
  const candidates: {
    readonly place: Omit<NearbyPlaceDto, "meters">;
    readonly at: GeoPoint | null;
  }[] = [
    ...destinations
      .filter(
        (destination) =>
          !(here.kind === "destination" && destination.slug === here.slug) &&
          destination.slug !== here.venue,
      )
      .map((destination) => ({
        place: {
          key: `destination:${destination.slug}`,
          kind: "destination" as const,
          title: destination.title,
          href: PORTAL_PATHS.destination(destination.slug),
          detail: categories.get(`destination:${destination.slug}`) ?? null,
          cover: destination.cover,
        },
        at: destination.location,
      })),
    ...events
      .filter(
        (event) =>
          !(here.kind === "event" && event.slug === here.slug) &&
          !(here.kind === "destination" && event.venue?.slug === here.slug),
      )
      .map((event) => ({
        place: {
          key: `event:${event.slug}`,
          kind: "event" as const,
          title: event.title,
          href: PORTAL_PATHS.event(event.slug),
          detail: formatEventSchedule(event.schedule),
          cover: event.cover,
        },
        at: event.location,
      })),
  ];
  const nearby = here.location
    ? nearestPlaces(here.location, candidates, (candidate) => candidate.at).map(
        ({ place: candidate, meters }) => ({ ...candidate.place, meters }),
      )
    : [];
  return {
    category: categories.get(`${here.kind}:${here.slug}`) ?? null,
    circuits: circuits
      .filter((circuit) => circuit.stops.some((stop) => stop.slug === here.slug))
      .map(({ slug, name }) => ({ slug, name })),
    eventsHere,
    nearby,
  };
}
