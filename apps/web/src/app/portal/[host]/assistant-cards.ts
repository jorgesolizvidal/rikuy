/**
 * What the assistant's answers show of each place they name (C3 · Paso 6, ADR-065): a
 * destination or an event cited as a source, or a stop of a plan, as a card with its cover,
 * its category and its real badges. Built by the portal's server from what is published (never
 * from the model), sent next to the answer and looked up by the place's address.
 */
export interface AssistantPlaceCard {
  /** The place's page: the key the panel looks it up by (a source's or a stop's href). */
  readonly href: string;
  /** Where it actually leads, when not `href` (ADR-071); null: nowhere to open. */
  readonly link?: string | null;
  readonly kind: "destination" | "event";
  readonly title: string;
  /** The municipality's category (ADR-062). */
  readonly category: string | null;
  /** An event's date, in words. */
  readonly date: string | null;
  /** Its cover, from the portal's own address (ADR-050); decorative: the title is beside it. */
  readonly image: {
    readonly src: string;
    readonly srcSet: string;
    readonly width: number;
    readonly height: number;
  } | null;
  /** It has a published 360° tour. */
  readonly tour: boolean;
  /** A stop of a published circuit: the place its stamp is kept by (ADR-057). */
  readonly stampPlaceId: string | null;
}

/** Cards in a narrow panel: a phone's width, or the side panel's on a wider screen. */
export const ASSISTANT_CARD_SIZES = "(min-width: 48rem) 28rem, 100vw";
