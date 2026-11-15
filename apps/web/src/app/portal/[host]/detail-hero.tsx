import type { ResponsiveImage } from "@/server/portal-content";

import { CardFlags } from "./destination-card";
import { PortalImage } from "./portal-image";

/** The cover is the page's largest image and its LCP: it fills the content's width. */
const COVER_SIZES = "(min-width: 72rem) 72rem, 100vw";

/**
 * The top of a destination's or an event's page (C3 · Paso 4, ADR-063): its cover photo with
 * the category, the title and the real badges over it («Recorrido 360°», «Sello del
 * pasaporte»), and the date block for an event. Without a photo, the same in text.
 */
export function DetailHero({
  title,
  category,
  cover,
  tour = false,
  stamp = false,
  date = null,
}: {
  readonly title: string;
  readonly category: string | null;
  readonly cover: ResponsiveImage | null;
  readonly tour?: boolean;
  readonly stamp?: boolean;
  /** An event's first day (the full date is in words on the page). */
  readonly date?: { readonly day: string; readonly month: string } | null;
}) {
  return (
    <header className="portal-detail-hero" data-photo={cover ? "" : undefined}>
      {cover ? (
        <PortalImage className="portal-detail-cover" image={cover} sizes={COVER_SIZES} priority />
      ) : null}
      <CardFlags tour={tour} stamp={stamp} />
      <div className="portal-detail-heading">
        {date ? (
          <span className="portal-event-date" aria-hidden="true">
            <span className="portal-event-day">{date.day}</span>
            <span className="portal-event-month">{date.month}</span>
          </span>
        ) : null}
        <div>
          {category ? <p className="portal-kicker">{category}</p> : null}
          <h1 className="portal-page-title">{title}</h1>
        </div>
      </div>
    </header>
  );
}
