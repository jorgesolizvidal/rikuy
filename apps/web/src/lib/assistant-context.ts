/**
 * What a 360° tour tells the assistant (ADR-040): the tour, the scene on screen and the point
 * open, as IDs. The tour keeps it current; the assistant's panel reads it with each question
 * and the server checks it against the published tour (never trusted as it comes).
 *
 * One module instance per page: the tour (in the page) and the panel (loaded on demand)
 * share it. The tour's buttons ask through an event, so neither imports the other.
 */

export interface TourAssistantContext {
  readonly page: { readonly kind: "destination_tour" | "event_tour"; readonly slug: string };
  readonly sceneId: string | null;
  readonly hotspotId: string | null;
}

let current: TourAssistantContext | null = null;

export function setTourAssistantContext(value: TourAssistantContext | null): void {
  current = value;
}

export function tourAssistantContext(): TourAssistantContext | null {
  return current;
}

export interface AssistantAskDetail {
  readonly question: string;
  readonly intent: "guide";
  readonly tour: TourAssistantContext;
  /** Where the focus goes back when the assistant closes (the button that asked). */
  readonly returnFocus?: HTMLElement | null;
}

export const ASSISTANT_ASK_EVENT = "rikuy:assistant-ask";

/** Opens the assistant and asks this question (the floating button listens). */
export function requestAssistant(detail: AssistantAskDetail): void {
  window.dispatchEvent(new CustomEvent<AssistantAskDetail>(ASSISTANT_ASK_EVENT, { detail }));
}
