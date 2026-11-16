import "server-only";

import {
  askAssistant,
  dictationPrompt,
  formatEventSchedule,
  passageVisibleWith,
  PORTAL_PATHS,
  type AssistantLink,
  type AssistantReply,
  type DictationResult,
  type AssistantPage,
  type AssistantPageItem,
  type AssistantResult,
  type AssistantTenant,
} from "@rikuy/core";

import {
  aiPlaceNotices,
  aiTourContext,
  runAiWork,
  searchAiKnowledge,
  transcribeAudio,
} from "./ai-gateway";
import type { AssistantPlaceCard } from "@/app/portal/[host]/assistant-cards";

import {
  categoriesByKey,
  portalBadges,
  portalDestination,
  portalDestinations,
  portalEvent,
  portalEvents,
  portalIndex,
  portalPassport,
  portalPlanPlaces,
  portalTourIndex,
  responsiveImage,
} from "./portal-content";
import { portalHas, type PortalView } from "./portal-view";

/**
 * The visitor's assistant for one portal (ADR-038). The municipality is the one the host
 * resolved; the page the browser names is looked up among this municipality's published
 * items, or ignored.
 */

async function pageItem(view: PortalView, page: AssistantPage): Promise<AssistantPageItem | null> {
  if (page.slug === null) return null;
  const tour = page.kind === "destination_tour" || page.kind === "event_tour" ? " (tour 360°)" : "";
  if (page.kind === "destination" || page.kind === "destination_tour") {
    const destination = await portalDestination(view, page.slug);
    return destination
      ? { label: `Destino «${destination.title}»${tour}`, title: destination.title }
      : null;
  }
  if (page.kind === "event" || page.kind === "event_tour") {
    const event = await portalEvent(view, page.slug);
    return event ? { label: `Evento «${event.title}»${tour}`, title: event.title } : null;
  }
  return null;
}

export async function askPortalAssistant(
  view: PortalView,
  body: unknown,
  visitor: string | null,
): Promise<AssistantResult> {
  const tours = await portalTourIndex(view);
  const tenant: AssistantTenant = {
    tenantId: view.context.tenant.tenantId,
    timezone: view.context.tenant.timezone,
    presentation: view.resolved.presentation,
    hasTours: tours.length > 0,
  };
  const modules = view.context.tenant.modules;
  const result = await askAssistant(tenant, body, visitor, {
    session: (input, work) => runAiWork(input, work),
    // Nothing of a module the municipality does not have (ADR-060): a few more are asked
    // for, so leaving some out still leaves enough.
    search: async (tenantId, query, limit) =>
      (await searchAiKnowledge(tenantId, query, limit * 2))
        .filter((passage) => passageVisibleWith(modules, passage))
        .slice(0, limit),
    page: (_tenantId, page) => pageItem(view, page),
    places: () => portalPlanPlaces(view),
    // The notices in force of the place the visitor is on (ADR-069): read first.
    placeNotices: aiPlaceNotices,
    tourContext: aiTourContext,
    now: () => new Date(),
  });
  return withPortalSections(view, result);
}

/** No link to a section the portal does not have (the agenda or the map, ADR-060). */
function withPortalSections(view: PortalView, result: AssistantResult): AssistantResult {
  const hidden = new Set<string>([
    ...(portalHas(view, "agenda") ? [] : [PORTAL_PATHS.agenda]),
    ...(portalHas(view, "map") ? [] : [PORTAL_PATHS.map]),
  ]);
  if (hidden.size === 0) return result;
  const links = (list: readonly AssistantLink[]) => list.filter((link) => !hidden.has(link.href));
  const { reply } = result;
  if (reply.status === "notice") {
    return {
      ...result,
      reply: { ...reply, notice: { ...reply.notice, links: links(reply.notice.links) } },
    };
  }
  if (reply.status !== "answered") return result;
  return {
    ...result,
    reply: {
      ...reply,
      links: links(reply.links),
      ...(reply.plan
        ? { plan: { ...reply.plan, mapHref: portalHas(view, "map") ? reply.plan.mapHref : null } }
        : {}),
    },
  };
}

/** A place's page in an answer: `/destinos/{slug}` or `/agenda/{slug}`, nothing deeper. */
function placeOf(href: string): { kind: "destination" | "event"; slug: string } | null {
  const match = /^\/(destinos|agenda)\/([a-z0-9-]+)$/u.exec(href);
  if (!match?.[2]) return null;
  return { kind: match[1] === "destinos" ? "destination" : "event", slug: match[2] };
}

/**
 * The cards of the places an answer names (C3 · Paso 6, ADR-065): its cited destinations and
 * events and its plan's stops, from what this portal publishes — never from the model. A place
 * that is not published (an event that ended, a page of another kind) has no card: the answer
 * shows its plain link. A failure leaves the cards out; the answer is unchanged.
 */
export async function assistantPlaceCards(
  view: PortalView,
  reply: AssistantReply,
): Promise<AssistantPlaceCard[]> {
  if (reply.status !== "answered") return [];
  const wanted = new Map<string, { kind: "destination" | "event"; slug: string }>();
  for (const href of [
    ...reply.sources.map((source) => source.href),
    ...(reply.plan?.stops.map((stop) => stop.href) ?? []),
  ]) {
    const place = href ? placeOf(href) : null;
    if (href && place) wanted.set(href, place);
  }
  if (wanted.size === 0) return [];
  try {
    const tenantId = view.context.tenant.tenantId;
    const [destinations, events, index, badges, circuits] = await Promise.all([
      portalDestinations(view),
      portalHas(view, "agenda") ? portalEvents(view) : Promise.resolve([]),
      portalIndex(view),
      portalBadges(view),
      portalPassport(view),
    ]);
    const categories = categoriesByKey(index);
    const stampIds = new Map(
      circuits.flatMap((circuit) =>
        circuit.stops.flatMap((stop) => (stop.id ? [[stop.slug, stop.id] as const] : [])),
      ),
    );
    const image = (cover: Parameters<typeof responsiveImage>[1] | null) => {
      if (!cover) return null;
      const { src, srcSet, width, height } = responsiveImage(tenantId, cover);
      return { src, srcSet, width, height };
    };
    const cards: AssistantPlaceCard[] = [];
    for (const [href, place] of wanted) {
      const key = `${place.kind}:${place.slug}`;
      if (place.kind === "destination") {
        const destination = destinations.find((item) => item.slug === place.slug);
        if (!destination) continue;
        cards.push({
          href,
          kind: "destination",
          title: destination.title,
          category: categories.get(key) ?? null,
          date: null,
          image: image(destination.cover),
          tour: badges.tours.has(key),
          stampPlaceId: stampIds.get(place.slug) ?? null,
        });
      } else {
        const event = events.find((item) => item.slug === place.slug);
        if (!event) continue;
        cards.push({
          href,
          kind: "event",
          title: event.title,
          category: categories.get(key) ?? null,
          date: formatEventSchedule(event.schedule),
          image: image(event.cover),
          tour: badges.tours.has(key),
          stampPlaceId: null,
        });
      }
    }
    return cards;
  } catch {
    return [];
  }
}

/**
 * One dictation for this portal (ADR-041). The provider is told how the municipality and its
 * published places are spelled — plain names, never instructions — so «Ucureña» is not heard
 * as something else. Without them (a read fails), the municipality's name alone.
 */
export async function transcribePortalDictation(
  view: PortalView,
  audio: Uint8Array,
  visitor: string | null,
): Promise<DictationResult> {
  const places = await Promise.all([portalDestinations(view), portalEvents(view)])
    .then(([destinations, events]) => [
      ...destinations.map((destination) => destination.title),
      ...events.map((event) => event.title),
    ])
    .catch(() => []);
  return transcribeAudio({
    tenantId: view.context.tenant.tenantId,
    audio,
    visitor,
    prompt: dictationPrompt(view.resolved.presentation.identity.siteName, places),
  });
}
