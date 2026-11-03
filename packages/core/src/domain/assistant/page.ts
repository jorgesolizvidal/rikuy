/**
 * Where the visitor asks from (ADR-038). The browser says only the kind of page and its
 * address; the server finds that published item of the same municipality, or ignores it.
 * Derived from the path so no page has to pass anything to the assistant.
 */
export const ASSISTANT_PAGE_KINDS = [
  "home",
  "destinations",
  "destination",
  "destination_tour",
  "agenda",
  "event",
  "event_tour",
  "map",
  "general_tour",
  "other",
] as const;

export type AssistantPageKind = (typeof ASSISTANT_PAGE_KINDS)[number];

export interface AssistantPage {
  readonly kind: AssistantPageKind;
  /** The destination's or event's address, for the kinds that have one. */
  readonly slug: string | null;
}

/** Same rule as the content addresses (lowercase words joined by hyphens). */
export const ASSISTANT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const SLUG = "([a-z0-9]+(?:-[a-z0-9]+)*)";
const PATTERNS: readonly (readonly [RegExp, AssistantPageKind])[] = [
  [/^\/?$/u, "home"],
  [/^\/destinos\/?$/u, "destinations"],
  [new RegExp(`^/destinos/${SLUG}/tour/?$`, "u"), "destination_tour"],
  [new RegExp(`^/destinos/${SLUG}/?$`, "u"), "destination"],
  [/^\/agenda\/?$/u, "agenda"],
  [new RegExp(`^/agenda/${SLUG}/tour/?$`, "u"), "event_tour"],
  [new RegExp(`^/agenda/${SLUG}/?$`, "u"), "event"],
  [/^\/mapa\/?$/u, "map"],
  [/^\/recorrido\/?$/u, "general_tour"],
];

/** The page of a portal path (`/destinos/mirador-del-valle` → destination). */
export function assistantPageFromPath(pathname: string): AssistantPage {
  for (const [pattern, kind] of PATTERNS) {
    const match = pattern.exec(pathname);
    if (match) return { kind, slug: match[1] ?? null };
  }
  return { kind: "other", slug: null };
}

/** Kinds that name one destination or event. */
export function pageHasItem(kind: AssistantPageKind): boolean {
  return (
    kind === "destination" ||
    kind === "destination_tour" ||
    kind === "event" ||
    kind === "event_tour"
  );
}
