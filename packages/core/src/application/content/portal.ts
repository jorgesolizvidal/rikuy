import { CONTENT_IMAGE_WIDTHS } from "../../domain/media/rules";
import { richTextToPlainText } from "../../contracts/rich-text";
import { contentImagePath } from "../media/content-images";
import type {
  PublishedDestination,
  PublishedDestinationReader,
  PublishedDestinationSummary,
  PublishedImage,
} from "./ports";

/** Public paths of the portal (one place, so links, sitemap and QR agree). */
export const PORTAL_PATHS = {
  destinations: "/destinos",
  destination: (slug: string) => `/destinos/${encodeURIComponent(slug)}`,
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

/** sitemap.xml of one portal: home, listing, each published destination and legal pages. */
export function buildSitemap(
  origin: string,
  destinations: readonly PublishedDestinationSummary[],
): string {
  const entry = (path: string, lastModified?: string) =>
    `<url><loc>${escapeXml(`${origin}${path}`)}</loc>${
      lastModified ? `<lastmod>${new Date(lastModified).toISOString()}</lastmod>` : ""
    }</url>`;
  const latest = destinations
    .map((d) => d.updatedAt)
    .sort()
    .at(-1);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    entry("/", latest),
    entry(PORTAL_PATHS.destinations, latest),
    ...destinations.map((d) => entry(PORTAL_PATHS.destination(d.slug), d.updatedAt)),
    entry(PORTAL_PATHS.privacy),
    entry(PORTAL_PATHS.terms),
    "</urlset>",
  ].join("\n");
}

export function buildRobotsTxt(origin: string): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`;
}

/**
 * Short per-instance cache of published destinations (default 30 s), keyed by tenant
 * (and slug). Publishing becomes visible within that window; concurrent requests for
 * the same key share one database call. Errors are not cached.
 */
export function createCachedPublishedDestinationReader(
  inner: PublishedDestinationReader,
  options: {
    readonly ttlMs?: number;
    readonly now?: () => number;
    readonly maxEntries?: number;
  } = {},
): PublishedDestinationReader {
  const ttl = options.ttlMs ?? 30_000;
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 1_000;
  const entries = new Map<string, { expires: number; value: Promise<unknown> }>();

  function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
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
  }

  return {
    list: (tenantId) => cached(`list:${tenantId}`, () => inner.list(tenantId)),
    find: (tenantId, slug) => cached(`find:${tenantId}:${slug}`, () => inner.find(tenantId, slug)),
  };
}
