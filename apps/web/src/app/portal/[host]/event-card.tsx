import {
  eventDateBadge,
  formatEventSchedule,
  PORTAL_PATHS,
  type PublishedEventSummary,
} from "@rikuy/core";

import { responsiveImage } from "@/server/portal-content";

import { CardFlags, type CardBadges } from "./destination-card";
import { PortalImage } from "./portal-image";
import { DistanceText } from "./visitor-location";

const PHOTO_SIZES = "(min-width: 60rem) 18rem, (min-width: 40rem) 40vw, 100vw";

/**
 * An event in a list: date block, title, when and where; one link named by its title. With
 * `photo` (the agenda and the home's «Tarjetas con foto», ADR-062) its photo comes first,
 * with the date block on it; without a photo the block stands alone.
 */
export function EventCard({
  event,
  headingLevel = 3,
  photo = null,
  badges = {},
}: {
  readonly event: PublishedEventSummary;
  readonly headingLevel?: 2 | 3;
  /** The tenant, to show the event's photo; null keeps the compact row. */
  readonly photo?: { readonly tenantId: string; readonly priority?: boolean } | null;
  readonly badges?: CardBadges;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const badge = eventDateBadge(event.schedule);
  const date = (
    <span className="portal-event-date" aria-hidden="true">
      <span className="portal-event-day">{badge.day}</span>
      <span className="portal-event-month">{badge.month}</span>
    </span>
  );
  return (
    <li className="portal-event" data-photo={photo ? "" : undefined}>
      <a href={PORTAL_PATHS.event(event.slug)}>
        {photo ? (
          <span className="portal-event-media">
            {event.cover ? (
              <PortalImage
                image={responsiveImage(photo.tenantId, event.cover)}
                sizes={PHOTO_SIZES}
                priority={photo.priority === true}
              />
            ) : null}
            {date}
            <CardFlags tour={badges.tour} />
          </span>
        ) : (
          date
        )}
        <span className="portal-event-text">
          {badges.category ? <span className="portal-card-kicker">{badges.category}</span> : null}
          <Heading className="portal-event-title">{event.title}</Heading>
          <span className="portal-event-when">{formatEventSchedule(event.schedule)}</span>
          {event.venue ? <span className="portal-event-where">{event.venue.title}</span> : null}
          {photo && event.summary ? (
            <span className="portal-event-summary">{event.summary}</span>
          ) : null}
          {event.location ? <DistanceText point={event.location} compact /> : null}
        </span>
      </a>
    </li>
  );
}
