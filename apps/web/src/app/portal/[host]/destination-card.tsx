import { PORTAL_PATHS, type PublishedDestinationSummary } from "@rikuy/core";

import { responsiveImage } from "@/server/portal-content";

import { PortalImage } from "./portal-image";

const CARD_SIZES = "(min-width: 72rem) 22rem, (min-width: 40rem) 45vw, 100vw";

/** A destination in a list: the whole card is one link named by its title. */
export function DestinationCard({
  tenantId,
  destination,
  headingLevel = 3,
  priority = false,
}: {
  readonly tenantId: string;
  readonly destination: PublishedDestinationSummary;
  readonly headingLevel?: 2 | 3;
  readonly priority?: boolean;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <li className="portal-card">
      <a href={PORTAL_PATHS.destination(destination.slug)}>
        <div className="portal-card-media">
          {destination.cover ? (
            <PortalImage
              image={responsiveImage(tenantId, destination.cover)}
              sizes={CARD_SIZES}
              priority={priority}
            />
          ) : null}
        </div>
        <Heading className="portal-card-title">{destination.title}</Heading>
        {destination.summary ? <p className="portal-card-text">{destination.summary}</p> : null}
      </a>
    </li>
  );
}
