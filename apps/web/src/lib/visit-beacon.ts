/**
 * The browser's side of the anonymous visit counts (ADR-051): what it opened or did, sent to
 * POST /visita without waiting for an answer. No cookies and nothing stored on the phone;
 * the server never trusts it as it comes. Kept free of @rikuy/core: it is in every page.
 */

/** PORTAL_PATHS.visit and QR_SCAN_QUERY of @rikuy/core (a test checks they agree). */
export const VISIT_ENDPOINT = "/visita";
export const QR_PARAM = "qr";

export type VisitEventName = "view" | "scene" | "directions" | "share" | "calendar" | "qr";

export function sendVisit(event: VisitEventName, path: string, scene?: string): void {
  const body = JSON.stringify(scene ? { path, event, scene } : { path, event });
  try {
    // text/plain: a simple request; the server reads it as JSON.
    if (navigator.sendBeacon?.(VISIT_ENDPOINT, new Blob([body], { type: "text/plain" }))) return;
  } catch {
    // Fall back to fetch below.
  }
  void fetch(VISIT_ENDPOINT, {
    method: "POST",
    body,
    keepalive: true,
    headers: { "content-type": "text/plain" },
  }).catch(() => undefined);
}

/** The tour page of a place: where its scenes are counted. */
export function tourPagePath(kind: "destination_tour" | "event_tour", slug: string): string {
  return `${kind === "destination_tour" ? "/destinos" : "/agenda"}/${slug}/tour`;
}
