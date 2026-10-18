import {
  eventDateBadge,
  formatEventSchedule,
  PORTAL_PATHS,
  type PublishedEventSummary,
} from "@rikuy/core";

import { DistanceText } from "./visitor-location";

/** An event in a list: date badge, title, when and where; one link named by its title. */
export function EventCard({
  event,
  headingLevel = 3,
}: {
  readonly event: PublishedEventSummary;
  readonly headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const badge = eventDateBadge(event.schedule);
  return (
    <li className="portal-event">
      <a href={PORTAL_PATHS.event(event.slug)}>
        <span className="portal-event-date" aria-hidden="true">
          <span className="portal-event-day">{badge.day}</span>
          <span className="portal-event-month">{badge.month}</span>
        </span>
        <span className="portal-event-text">
          <Heading className="portal-event-title">{event.title}</Heading>
          <span className="portal-event-when">{formatEventSchedule(event.schedule)}</span>
          {event.venue ? <span className="portal-event-where">{event.venue.title}</span> : null}
          {event.location ? <DistanceText point={event.location} compact /> : null}
        </span>
      </a>
    </li>
  );
}
