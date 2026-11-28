import type { PublicCitation } from "../../contracts/knowledge";
import type { AssistantReply } from "./ask";
import type { AssistantPlanStop } from "./plan";

/**
 * Where the assistant's answers link (ADR-071). The answer is built as always, with the
 * portal's own paths; the server then decides, item by item, where each one leads:
 *
 * - inside the municipality's website (`embed`), or without a public portal: its page on that
 *   website, when it has one;
 * - otherwise, with a portal, the portal's page (unchanged); without one, no link at all.
 *
 * Without a portal there are no sections to offer and no map to show the route on.
 */

/** Where the question was asked: the portal's button, the page of a QR, or a website's frame. */
export type AssistantChannel = "portal" | "qr" | "embed";

export function parseAssistantChannel(value: unknown): AssistantChannel {
  if (value === "insertar" || value === "embed") return "embed";
  if (value === "qr") return "qr";
  return "portal";
}

export interface AssistantLinkPolicy {
  /** The municipality has its public portal (ADR-071). */
  readonly portal: boolean;
  readonly channel: AssistantChannel;
  /** «Página en la web del municipio» of what is published, by `kind:slug`. */
  readonly webLinks: ReadonlyMap<string, string>;
}

const PAGE = /^\/(destinos|agenda)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/u;
const ANCHORED = /^\/(avisos|servicios|memoria|preguntas-frecuentes)#([a-z0-9]+(?:-[a-z0-9]+)*)$/u;
const ANCHOR_KIND: Readonly<Record<string, string>> = {
  avisos: "notice",
  servicios: "service",
  memoria: "story",
  "preguntas-frecuentes": "faq",
};

/** The published item a portal path is about (`kind:slug`), or null (a tour, a section). */
export function contentKeyOfPath(href: string): string | null {
  const page = PAGE.exec(href);
  if (page?.[1] && page[2]) return `${page[1] === "destinos" ? "destination" : "event"}:${page[2]}`;
  const anchored = ANCHORED.exec(href);
  if (anchored?.[1] && anchored[2]) return `${ANCHOR_KIND[anchored[1]]}:${anchored[2]}`;
  return null;
}

/**
 * Where a portal path leads under the policy: `undefined` keeps it (the portal's page), a string
 * is the municipality's own page, null is no link.
 */
export function linkFor(
  href: string | null,
  policy: AssistantLinkPolicy,
): string | null | undefined {
  if (href === null) return undefined;
  const key = contentKeyOfPath(href);
  const web = key ? policy.webLinks.get(key) : undefined;
  if (web && (!policy.portal || policy.channel === "embed")) return web;
  return policy.portal ? undefined : null;
}

/** A citation, a stop or a card, with where it actually leads when that is not its `href`. */
export type Linked<T> = T & { readonly link?: string | null };

function withLink<T extends { readonly href: string | null }>(
  item: T,
  policy: AssistantLinkPolicy,
): Linked<T> {
  const link = linkFor(item.href, policy);
  return link === undefined ? item : { ...item, link };
}

/** The answer with every link decided (its `href`s stay: the cards are looked up by them). */
export function retargetReply(reply: AssistantReply, policy: AssistantLinkPolicy): AssistantReply {
  if (reply.status === "notice") {
    return policy.portal ? reply : { ...reply, notice: { ...reply.notice, links: [] } };
  }
  if (reply.status !== "answered") return reply;
  const sources: Linked<PublicCitation>[] = reply.sources.map((source) => withLink(source, policy));
  const plan = reply.plan
    ? {
        ...reply.plan,
        stops: reply.plan.stops.map((stop): Linked<AssistantPlanStop> => withLink(stop, policy)),
        mapHref: policy.portal ? reply.plan.mapHref : null,
      }
    : undefined;
  return {
    ...reply,
    sources,
    links: policy.portal ? reply.links : [],
    ...(plan ? { plan } : {}),
  };
}

/** The cards of the places an answer names, with the same links as its sources. */
export function retargetCards<T extends { readonly href: string }>(
  cards: readonly T[],
  policy: AssistantLinkPolicy,
): Linked<T>[] {
  return cards.map((card) => withLink(card, policy));
}
