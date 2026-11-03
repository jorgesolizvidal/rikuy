import "server-only";

import {
  askAssistant,
  type AssistantPage,
  type AssistantPageItem,
  type AssistantResult,
  type AssistantTenant,
} from "@rikuy/core";

import { runAiWork, searchAiKnowledge } from "./ai-gateway";
import { portalDestination, portalEvent, portalTourIndex } from "./portal-content";
import type { PortalView } from "./portal-view";

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
  return askAssistant(tenant, body, visitor, {
    session: (input, work) => runAiWork(input, work),
    search: searchAiKnowledge,
    page: (_tenantId, page) => pageItem(view, page),
    now: () => new Date(),
  });
}
