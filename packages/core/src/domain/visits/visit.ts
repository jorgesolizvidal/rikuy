import { assistantPageFromPath, type AssistantPageKind } from "../assistant/page";

/**
 * Anonymous visit counts (C1 · Paso 1, ADR-051). The portal's pages come from the CDN cache,
 * so the visitor's browser says what it opened; the server checks it here and the database
 * checks it again (the place must be published, the scene in its published tour). Only daily
 * totals are kept; the visitor goes to the database as a key that it hashes with a salt of
 * the day and forgets two days later. No cookies, nothing stored on the phone.
 */

export const VISIT_EVENTS = ["view", "scene", "directions", "share", "calendar", "qr"] as const;
export type VisitEvent = (typeof VISIT_EVENTS)[number];

export type VisitTarget = Exclude<AssistantPageKind, "other">;

/** What the browser reported, already checked. */
export interface VisitHit {
  readonly target: VisitTarget;
  /** The destination's or event's address, for the targets that name one. */
  readonly slug: string | null;
  readonly sceneId: string | null;
  readonly event: VisitEvent;
}

export interface VisitOrigin {
  /** ISO 3166-1 alpha-2, as the CDN estimates it from the connection. */
  readonly country: string | null;
  readonly city: string | null;
}

export interface VisitRecord extends VisitHit, VisitOrigin {
  readonly tenantId: string;
  /** Address and browser: the database keeps only a daily-salted hash of it. */
  readonly visitor: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const PLACE_TARGETS: readonly VisitTarget[] = [
  "destination",
  "event",
  "destination_tour",
  "event_tour",
];
const QR_TARGETS: readonly VisitTarget[] = [...PLACE_TARGETS, "general_tour"];

/** Which events each page can report (the database has the same rule). */
export function visitEventAllowed(target: VisitTarget, event: VisitEvent): boolean {
  switch (event) {
    case "view":
      return true;
    case "scene":
      return target === "destination_tour" || target === "event_tour";
    case "directions":
    case "share":
      return target === "destination" || target === "event";
    case "calendar":
      return target === "event";
    case "qr":
      return QR_TARGETS.includes(target);
  }
}

/**
 * The body of a beacon: `{ path, event, scene? }`. The path is the page's (for a scene, the
 * tour's page). Anything else, or an event the page cannot have, is null.
 */
export function parseVisitBeacon(body: unknown): VisitHit | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const { path, event, scene } = body as Record<string, unknown>;
  if (typeof path !== "string" || path.length > 200 || !path.startsWith("/")) return null;
  if (typeof event !== "string" || !(VISIT_EVENTS as readonly string[]).includes(event)) {
    return null;
  }
  const page = assistantPageFromPath(path);
  if (page.kind === "other") return null;
  const target = page.kind;
  const visitEvent = event as VisitEvent;
  if (!visitEventAllowed(target, visitEvent)) return null;
  let sceneId: string | null = null;
  if (visitEvent === "scene") {
    if (typeof scene !== "string" || !UUID.test(scene)) return null;
    sceneId = scene;
  } else if (scene !== undefined) {
    return null;
  }
  const slug = PLACE_TARGETS.includes(target) ? page.slug : null;
  if (PLACE_TARGETS.includes(target) && slug === null) return null;
  return { target, slug, sceneId, event: visitEvent };
}

const COUNTRY = /^[A-Z]{2}$/u;
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/gu;

/**
 * The approximate origin from the CDN's headers (`x-vercel-ip-country`,
 * `x-vercel-ip-city`, URL-encoded). A city only with its country; unknown values are null.
 */
export function visitOrigin(country: string | null, city: string | null): VisitOrigin {
  const code = country?.trim().toUpperCase() ?? "";
  if (!COUNTRY.test(code) || code === "XX") return { country: null, city: null };
  let name: string | null = null;
  if (city) {
    try {
      name = decodeURIComponent(city).replace(CONTROL, "").trim().slice(0, 80) || null;
    } catch {
      name = null;
    }
  }
  return { country: code, city: name };
}

/** The key the database hashes: never stored as such. */
export function visitorKey(address: string | null, userAgent: string | null): string | null {
  const ip = address?.trim();
  if (!ip) return null;
  return `${ip.slice(0, 64)}|${(userAgent ?? "").slice(0, 300)}`;
}

const AUTOMATED =
  /bot|crawl|spider|slurp|lighthouse|headless|phantom|preview|facebookexternalhit|whatsapp|curl|wget|python|node-fetch|axios|go-http/iu;

/** Search engines, link previews, Lighthouse and scripts: never counted. */
export function isAutomatedAgent(userAgent: string | null): boolean {
  return !userAgent || AUTOMATED.test(userAgent);
}

/** Everything the endpoint received, as one record to write; null: nothing to count. */
export function visitRecordFrom(input: {
  readonly tenantId: string;
  readonly body: unknown;
  readonly userAgent: string | null;
  readonly address: string | null;
  readonly country: string | null;
  readonly city: string | null;
}): VisitRecord | null {
  if (isAutomatedAgent(input.userAgent)) return null;
  const hit = parseVisitBeacon(input.body);
  if (hit === null) return null;
  return {
    tenantId: input.tenantId,
    ...hit,
    ...visitOrigin(input.country, input.city),
    visitor: visitorKey(input.address, input.userAgent),
  };
}
