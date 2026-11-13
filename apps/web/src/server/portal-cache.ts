import "server-only";

import { PORTAL_PATHS, tourPath } from "@rikuy/core";
import { revalidatePath } from "next/cache";

import {
  publishedContentReader,
  publishedEventReader,
  publishedPassportReader,
  publishedTourReader,
} from "./platform";

/**
 * Portal pages are cached per host (ADR-024). After a change visitors must see right away
 * (publishing content or the brand, rolling back), every page of that municipality is
 * marked stale, so the next visit rebuilds it with fresh data. Other municipalities keep
 * their cache. A failure here never fails the action: pages also expire on their own
 * (`revalidate` in the portal layout).
 */
export async function refreshPortal(
  hostnameOf: (tenantId: string) => Promise<string | null>,
  tenantId: string,
  /** Pages no list knows about: an address that changed, old and new (ADR-047). */
  extraPaths: readonly string[] = [],
): Promise<void> {
  try {
    const hostname = await hostnameOf(tenantId);
    if (!hostname) return;
    const [destinations, events, tours, circuits] = await Promise.all([
      publishedContentReader().list(tenantId),
      publishedEventReader().list(tenantId),
      publishedTourReader().index(tenantId),
      publishedPassportReader()
        .circuits(tenantId)
        .catch(() => []),
    ]);
    const base = `/portal/${encodeURIComponent(hostname)}`;
    const paths = [
      "",
      PORTAL_PATHS.destinations,
      PORTAL_PATHS.agenda,
      PORTAL_PATHS.privacy,
      PORTAL_PATHS.terms,
      ...destinations.map((destination) => PORTAL_PATHS.destination(destination.slug)),
      ...events.map((event) => PORTAL_PATHS.event(event.slug)),
      PORTAL_PATHS.generalTour,
      ...tours.map((tour) => tourPath(tour.kind, tour.slug)),
      PORTAL_PATHS.passport,
      ...circuits.map((circuit) => PORTAL_PATHS.passportCircuit(circuit.slug)),
      ...extraPaths,
    ];
    for (const path of paths) revalidatePath(`${base}${path}`);
  } catch {
    // Time-based revalidation still applies.
  }
}
