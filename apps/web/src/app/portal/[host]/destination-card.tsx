import { PORTAL_PATHS, type PublishedDestinationSummary } from "@rikuy/core";
import type { ReactNode } from "react";

import { responsiveImage } from "@/server/portal-content";

import { PortalImage } from "./portal-image";
import { DistanceText } from "./visitor-location";

const CARD_SIZES = "(min-width: 72rem) 22rem, (min-width: 40rem) 45vw, 100vw";
/** The featured card (ADR-062) spans two columns on wide screens. */
const FEATURED_SIZES = "(min-width: 72rem) 46rem, (min-width: 40rem) 92vw, 100vw";

/** What a card says about its place besides its own data (all of it real, ADR-062). */
export interface CardBadges {
  /** The municipality's category, if it gave it one. */
  readonly category?: string | null;
  /** It has a published 360° tour. */
  readonly tour?: boolean;
  /** It is a stop of a published circuit of the passport. */
  readonly stamp?: boolean;
}

/**
 * «Recorrido 360°» and «Sello del pasaporte»: on a detail page's cover (`placement="photo"`)
 * or, in a list, as a quiet line below the card's text (C3 · Paso 8: pills on every photo
 * covered the photos and repeated themselves down the list).
 */
export function CardFlags({
  tour = false,
  stamp = false,
  placement = "photo",
}: {
  readonly tour?: boolean | undefined;
  readonly stamp?: boolean | undefined;
  readonly placement?: "photo" | "text";
}) {
  if (!tour && !stamp) return null;
  return (
    <span className="portal-card-flags" data-placement={placement}>
      {tour ? (
        <span className="portal-flag">
          <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" focusable="false">
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              d="M3 12c0-2.2 4-4 9-4s9 1.8 9 4-4 4-9 4M8.5 15.6 12 16l-2.6 2.6M12 8V4"
            />
          </svg>
          Recorrido 360°
        </span>
      ) : null}
      {stamp ? (
        <span className="portal-flag">
          <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" focusable="false">
            <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2" />
            <path fill="none" stroke="currentColor" strokeWidth="2" d="m8.5 12 2.4 2.4 4.6-4.8" />
          </svg>
          Sello del pasaporte
        </span>
      ) : null}
    </span>
  );
}

/** A destination in a list: the whole card is one link named by its title. */
export function DestinationCard({
  tenantId,
  destination,
  headingLevel = 3,
  priority = false,
  extra = null,
  badges = {},
  featured = false,
}: {
  readonly tenantId: string;
  readonly destination: Pick<
    PublishedDestinationSummary,
    "slug" | "title" | "summary" | "location" | "cover"
  >;
  readonly headingLevel?: 2 | 3;
  readonly priority?: boolean;
  /** Below the text, inside the link (the passport's stamp of the place). */
  readonly extra?: ReactNode;
  readonly badges?: CardBadges;
  /** Larger, across two columns (the home's «Uno destacado»). */
  readonly featured?: boolean;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <li className="portal-card" data-featured={featured ? "" : undefined}>
      <a href={PORTAL_PATHS.destination(destination.slug)}>
        <div className="portal-card-media">
          {destination.cover ? (
            <PortalImage
              image={responsiveImage(tenantId, destination.cover)}
              sizes={featured ? FEATURED_SIZES : CARD_SIZES}
              priority={priority}
            />
          ) : null}
        </div>
        {badges.category ? <span className="portal-card-kicker">{badges.category}</span> : null}
        <Heading className="portal-card-title">{destination.title}</Heading>
        {destination.summary ? <p className="portal-card-text">{destination.summary}</p> : null}
        <CardFlags tour={badges.tour} stamp={badges.stamp} placement="text" />
        {destination.location ? <DistanceText point={destination.location} compact /> : null}
        {extra}
      </a>
    </li>
  );
}
