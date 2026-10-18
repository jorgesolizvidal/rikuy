import { CONTENT_IMAGE_WIDTHS } from "../../domain/media/rules";
import { richTextToPlainText } from "../../contracts/rich-text";
import { dayAfter } from "../../domain/events/schedule";
import { contentImagePath } from "../media/content-images";
import type {
  PublishedDestination,
  PublishedDestinationReader,
  PublishedDestinationSummary,
  PublishedEvent,
  PublishedEventReader,
  PublishedEventSummary,
  PublishedImage,
} from "./ports";

/** Public paths of the portal (one place, so links, sitemap and QR agree). */
export const PORTAL_PATHS = {
  destinations: "/destinos",
  destination: (slug: string) => `/destinos/${encodeURIComponent(slug)}`,
  agenda: "/agenda",
  event: (slug: string) => `/agenda/${encodeURIComponent(slug)}`,
  eventCalendar: (slug: string) => `/agenda/${encodeURIComponent(slug)}/calendario.ics`,
  privacy: "/privacidad",
  terms: "/terminos",
} as const;

export interface ImageCandidate {
  readonly path: string;
  readonly width: number;
  readonly height: number;
}

/**
 * The derivatives that actually exist for an image (never enlarged, so an 800 px original
 * has 480 and 800), smallest first, each with its real pixel size for `srcset`.
 */
export function imageCandidates(tenantId: string, image: PublishedImage): ImageCandidate[] {
  const seen = new Set<number>();
  const candidates: ImageCandidate[] = [];
  for (const target of CONTENT_IMAGE_WIDTHS) {
    const width = Math.min(target, image.width);
    if (seen.has(width)) continue;
    seen.add(width);
    candidates.push({
      path: contentImagePath(tenantId, image, `w${target}.webp`),
      width,
      height: Math.max(1, Math.round((image.height * width) / image.width)),
    });
  }
  return candidates;
}

/** Directions from wherever the visitor is (opens the maps app on phones). */
export function directionsUrl(point: { readonly lat: number; readonly lng: number }): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${point.lat},${point.lng}`;
}

/** The place on OpenStreetMap (an alternative to Google Maps). */
export function openStreetMapUrl(point: { readonly lat: number; readonly lng: number }): string {
  return `https://www.openstreetmap.org/?mlat=${point.lat}&mlon=${point.lng}#map=17/${point.lat}/${point.lng}`;
}

/** schema.org TouristAttraction for search engines (serialized safely by the caller). */
export function destinationJsonLd(
  destination: PublishedDestination,
  options: { readonly url: string; readonly imageUrl: string | null; readonly portalName: string },
): Record<string, unknown> {
  const description = destination.summary || richTextToPlainText(destination.body).slice(0, 300);
  return {
    "@context": "https://schema.org",
    "@type": "TouristAttraction",
    name: destination.title,
    ...(description ? { description } : {}),
    url: options.url,
    ...(options.imageUrl ? { image: options.imageUrl } : {}),
    ...(destination.location
      ? {
          geo: {
            "@type": "GeoCoordinates",
            latitude: destination.location.lat,
            longitude: destination.location.lng,
          },
        }
      : {}),
    isPartOf: { "@type": "WebSite", name: options.portalName },
  };
}

/** JSON for a <script type="application/ld+json">: `<` is escaped so no tag can close it. */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</gu, "\\u003c");
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/gu, (char) => `&#${char.charCodeAt(0)};`);
}

/** sitemap.xml of one portal: home, listings, published destinations, upcoming events. */
export function buildSitemap(
  origin: string,
  destinations: readonly PublishedDestinationSummary[],
  events: readonly PublishedEventSummary[] = [],
): string {
  const entry = (path: string, lastModified?: string) =>
    `<url><loc>${escapeXml(`${origin}${path}`)}</loc>${
      lastModified ? `<lastmod>${new Date(lastModified).toISOString()}</lastmod>` : ""
    }</url>`;
  const latest = (items: readonly { readonly updatedAt: string }[]) =>
    items
      .map((item) => item.updatedAt)
      .sort()
      .at(-1);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    entry("/", latest([...destinations, ...events])),
    entry(PORTAL_PATHS.destinations, latest(destinations)),
    ...destinations.map((d) => entry(PORTAL_PATHS.destination(d.slug), d.updatedAt)),
    entry(PORTAL_PATHS.agenda, latest(events)),
    ...events.map((e) => entry(PORTAL_PATHS.event(e.slug), e.updatedAt)),
    entry(PORTAL_PATHS.privacy),
    entry(PORTAL_PATHS.terms),
    "</urlset>",
  ].join("\n");
}

export function buildRobotsTxt(origin: string): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`;
}

/** schema.org Event (one occurrence, in person). All-day events use plain dates. */
export function eventJsonLd(
  event: PublishedEvent,
  options: {
    readonly url: string;
    readonly imageUrl: string | null;
    readonly portalName: string;
    readonly portalUrl: string;
  },
): Record<string, unknown> {
  const description = event.summary || richTextToPlainText(event.body).slice(0, 300);
  const allDay = event.schedule.allDay;
  return {
    "@context": "https://schema.org",
    "@type": "Event",
    name: event.title,
    ...(description ? { description } : {}),
    url: options.url,
    ...(options.imageUrl ? { image: options.imageUrl } : {}),
    startDate: allDay ? event.schedule.start : event.startsAt,
    endDate: allDay ? event.schedule.end : event.endsAt,
    eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    location: {
      "@type": "Place",
      name: event.venue?.title ?? event.title,
      ...(event.location
        ? {
            geo: {
              "@type": "GeoCoordinates",
              latitude: event.location.lat,
              longitude: event.location.lng,
            },
          }
        : {}),
    },
    organizer: { "@type": "Organization", name: options.portalName, url: options.portalUrl },
  };
}

// ── iCalendar (RFC 5545) ─────────────────────────────────────────────────────

function icsText(value: string): string {
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/;/gu, "\\;")
    .replace(/,/gu, "\\,")
    .replace(/\r?\n/gu, "\\n");
}

/** Lines longer than 75 octets continue on the next line after a space. */
function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    if (size + bytes > (parts.length === 0 ? 75 : 74)) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

const icsInstant = (iso: string) =>
  new Date(iso)
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}/u, "");

/**
 * An .ics file with the event, to add it to the visitor's calendar. Timed events use
 * UTC instants (already computed with the municipality's time zone), so every calendar
 * shows them at the right local hour; all-day events use dates (end exclusive).
 */
export function buildEventIcs(
  event: PublishedEvent,
  options: { readonly url: string; readonly uid: string; readonly portalName: string },
): string {
  const { schedule } = event;
  const where = [event.venue?.title, options.portalName].filter(Boolean).join(", ");
  const description = [event.summary, options.url].filter(Boolean).join("\n\n");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Rikuy//Agenda//ES",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${options.uid}`,
    `DTSTAMP:${icsInstant(event.updatedAt)}`,
    ...(schedule.allDay
      ? [
          `DTSTART;VALUE=DATE:${schedule.start.replaceAll("-", "")}`,
          `DTEND;VALUE=DATE:${dayAfter(schedule.end)}`,
        ]
      : [`DTSTART:${icsInstant(event.startsAt)}`, `DTEND:${icsInstant(event.endsAt)}`]),
    `SUMMARY:${icsText(event.title)}`,
    `DESCRIPTION:${icsText(description)}`,
    ...(where ? [`LOCATION:${icsText(where)}`] : []),
    ...(event.location ? [`GEO:${event.location.lat};${event.location.lng}`] : []),
    `URL:${options.url}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

// ── Caches ───────────────────────────────────────────────────────────────────

interface CacheOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly maxEntries?: number;
}

/** Per-instance TTL cache that shares in-flight loads and never keeps failures. */
function ttlCache(options: CacheOptions) {
  const ttl = options.ttlMs ?? 30_000;
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 1_000;
  const entries = new Map<string, { expires: number; value: Promise<unknown> }>();
  return function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = entries.get(key);
    if (hit && hit.expires > now()) return hit.value as Promise<T>;
    if (entries.size >= maxEntries) {
      const oldest = entries.keys().next();
      if (!oldest.done) entries.delete(oldest.value);
    }
    const value = load().catch((error: unknown) => {
      entries.delete(key);
      throw error;
    });
    entries.set(key, { expires: now() + ttl, value });
    return value;
  };
}

/**
 * Short per-instance cache of published destinations (default 30 s), keyed by tenant
 * (and slug). Publishing becomes visible within that window; concurrent requests for
 * the same key share one database call. Errors are not cached.
 */
export function createCachedPublishedDestinationReader(
  inner: PublishedDestinationReader,
  options: CacheOptions = {},
): PublishedDestinationReader {
  const cached = ttlCache(options);
  return {
    list: (tenantId) => cached(`list:${tenantId}`, () => inner.list(tenantId)),
    find: (tenantId, slug) => cached(`find:${tenantId}:${slug}`, () => inner.find(tenantId, slug)),
  };
}

/** Same for events: an event that ends leaves the agenda within the TTL. */
export function createCachedPublishedEventReader(
  inner: PublishedEventReader,
  options: CacheOptions = {},
): PublishedEventReader {
  const cached = ttlCache(options);
  return {
    list: (tenantId) => cached(`list:${tenantId}`, () => inner.list(tenantId)),
    find: (tenantId, slug) => cached(`find:${tenantId}:${slug}`, () => inner.find(tenantId, slug)),
  };
}
