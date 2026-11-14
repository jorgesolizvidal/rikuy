import "server-only";

import {
  askAssistant,
  dictationPrompt,
  passageVisibleWith,
  PORTAL_PATHS,
  type AssistantLink,
  type DictationResult,
  type AssistantPage,
  type AssistantPageItem,
  type AssistantResult,
  type AssistantTenant,
} from "@rikuy/core";

import { aiTourContext, runAiWork, searchAiKnowledge, transcribeAudio } from "./ai-gateway";
import {
  portalDestination,
  portalDestinations,
  portalEvent,
  portalEvents,
  portalPlanPlaces,
  portalTourIndex,
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
