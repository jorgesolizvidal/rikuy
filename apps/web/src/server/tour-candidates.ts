import "server-only";

import type { TourCandidate } from "@rikuy/core";

import { adminSession } from "./admin-session";

/**
 * Destinations and events that can get a tour (a new one, or one moved there): all
 * destinations and the events that have not ended. The use cases leave out those that
 * already have one.
 */
export async function tourCandidates(tenantId: string): Promise<readonly TourCandidate[]> {
  const session = await adminSession();
  const [destinations, events] = await Promise.all([
    session.content.listDestinations(tenantId),
    session.content.listEvents(tenantId),
  ]);
  return [
    ...destinations.map((entry) => ({
      contentId: entry.contentId,
      kind: "destination" as const,
      title: entry.title,
    })),
    ...events
      .filter((entry) => !entry.ended)
      .map((entry) => ({ contentId: entry.contentId, kind: "event" as const, title: entry.title })),
  ];
}
