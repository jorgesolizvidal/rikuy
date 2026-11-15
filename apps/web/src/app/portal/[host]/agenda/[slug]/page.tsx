import {
  nearbyRadiusOf,
  PORTAL_PATHS,
  directionsUrl,
  eventDateBadge,
  eventJsonLd,
  formatEventSchedule,
  serializeJsonLd,
  tourPath,
} from "@rikuy/core";
import type { Metadata } from "next";

import { RichTextView } from "@/components/rich-text";
import {
  movedOrNotFound,
  portalEvent,
  portalNearbyTargets,
  portalOrigin,
  portalHasTour,
  portalPlaceExtras,
  responsiveImage,
} from "@/server/portal-content";
import { portalHas, portalViewWith } from "@/server/portal-view";

import "../../detail.css";
import { DetailHero } from "../../detail-hero";
import { EventStatus } from "../../event-status";
import { PhotoGallery } from "../../photo-gallery";
import { NearbyPlaces, PlaceLocation, VisitorDistance } from "../../place-sections";
import { ShareButton } from "../../share-button";
import { NearbyNotice } from "../../visitor-location";

interface EventPageProps {
  readonly params: Promise<{ host: string; slug: string }>;
}

async function load(params: EventPageProps["params"]) {
  const { host, slug } = await params;
  const view = await portalViewWith(host, "agenda");
  if (view === null) return null;
  const event = await portalEvent(view, decodeURIComponent(slug));
  return event ? { view, event } : null;
}

export async function generateMetadata({ params }: EventPageProps): Promise<Metadata> {
  const loaded = await load(params);
  if (loaded === null) return {};
  const { view, event } = loaded;
  const cover = event.cover ? responsiveImage(view.context.tenant.tenantId, event.cover) : null;
  const when = formatEventSchedule(event.schedule);
  const description = event.summary ? `${when}. ${event.summary}` : when;
  return {
    title: event.title,
    description,
    alternates: { canonical: PORTAL_PATHS.event(event.slug) },
    // Ended events keep their page for shared links, but leave search results.
    ...(event.ended ? { robots: { index: false, follow: true } } : {}),
    openGraph: {
      type: "article",
      title: event.title,
      description,
      ...(cover
        ? {
            images: [
              {
                url: cover.largest.url,
                width: cover.largest.width,
                height: cover.largest.height,
                alt: cover.alt,
              },
            ],
          }
        : {}),
    },
  };
}

/** Rendered on the first visit and cached with the portal (ADR-024). */
export function generateStaticParams(): { slug: string }[] {
  return [];
}

export default async function EventPage({ params }: EventPageProps) {
  const loaded = await load(params);
  if (loaded === null) return movedOrNotFound(params, "event", PORTAL_PATHS.event);
  const { view, event } = loaded;
  const withMap = portalHas(view, "map");
  const [targets, tour, extras] = await Promise.all([
    portalNearbyTargets(view),
    portalHasTour(view, "event", event.slug, event.ended),
    portalPlaceExtras(view, {
      kind: "event",
      slug: event.slug,
      location: event.location,
      venue: event.venue?.slug ?? null,
    }),
  ]);
  const tenantId = view.context.tenant.tenantId;
  const { siteName } = view.resolved.presentation.identity;
  const origin = portalOrigin(view);
  const url = `${origin}${PORTAL_PATHS.event(event.slug)}`;
  const cover = event.cover ? responsiveImage(tenantId, event.cover) : null;
  const jsonLd = serializeJsonLd(
    eventJsonLd(event, {
      url,
      imageUrl: cover ? `${origin}${cover.largest.url}` : null,
      portalName: siteName,
      portalUrl: origin,
    }),
  );

  return (
    <article className="portal-page portal-detail">
      {event.ended ? null : (
        <script
          type="application/ld+json"
          // JSON built by us from validated data; `<` is escaped so it cannot end the tag.
          dangerouslySetInnerHTML={{ __html: jsonLd }}
        />
      )}
      <nav aria-label="Ruta de navegación" className="portal-breadcrumb">
        <ol>
          <li>
            <a href="/">Inicio</a>
          </li>
          <li>
            <a href={PORTAL_PATHS.agenda}>Agenda</a>
          </li>
          <li aria-current="page">{event.title}</li>
        </ol>
      </nav>

      <DetailHero
        title={event.title}
        category={extras.category}
        cover={cover}
        tour={tour}
        date={eventDateBadge(event.schedule)}
      />

      {event.ended ? (
        <p className="portal-ended" role="status">
          Este evento ya terminó. <a href={PORTAL_PATHS.agenda}>Ver los próximos eventos</a>.
        </p>
      ) : null}

      <div className="portal-detail-grid">
        {event.summary ? <p className="portal-lead portal-detail-lead">{event.summary}</p> : null}

        <aside className="portal-visit" aria-labelledby="para-tu-visita">
          <h2 id="para-tu-visita">Para tu visita</h2>
          <section aria-labelledby="cuando" className="portal-visit-when">
            <h3 id="cuando">Cuándo</h3>
            {event.ended ? null : (
              <EventStatus
                event={{ schedule: event.schedule, startsAt: event.startsAt, endsAt: event.endsAt }}
                timezone={view.context.tenant.timezone}
              />
            )}
            <p className="portal-event-headline">
              <time dateTime={event.schedule.allDay ? event.schedule.start : event.startsAt}>
                {formatEventSchedule(event.schedule)}
              </time>
            </p>
            {event.venue ? (
              <p className="portal-visit-venue">
                En <a href={PORTAL_PATHS.destination(event.venue.slug)}>{event.venue.title}</a>
              </p>
            ) : null}
            <p className="portal-visit-note">Fecha y hora del municipio.</p>
          </section>
          {event.location && !event.ended ? <VisitorDistance location={event.location} /> : null}
          {/* An ended event keeps only its tour (P4 · Paso 4): nothing else to go to. */}
          {event.ended && !tour ? null : (
            <div className="portal-actions">
              {event.location && !event.ended ? (
                <a
                  className="portal-button portal-button-primary"
                  data-visit="directions"
                  href={directionsUrl(event.location)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Cómo llegar<span className="visually-hidden"> (abre la app de mapas)</span>
                </a>
              ) : null}
              {event.ended ? null : (
                <a
                  className="portal-button"
                  data-visit="calendar"
                  href={PORTAL_PATHS.eventCalendar(event.slug)}
                  download={`${event.slug}.ics`}
                >
                  Añadir al calendario
                </a>
              )}
              {tour ? (
                <a className="portal-button portal-tour-link" href={tourPath("event", event.slug)}>
                  Ver el tour 360°
                </a>
              ) : null}
              {event.ended ? null : <ShareButton title={event.title} url={url} />}
            </div>
          )}
        </aside>

        <div className="portal-detail-main">
          {event.body.length > 0 ? (
            <div className="portal-prose">
              <RichTextView blocks={event.body} />
            </div>
          ) : null}

          {event.gallery.length > 0 ? (
            <PhotoGallery photos={event.gallery.map((image) => responsiveImage(tenantId, image))} />
          ) : null}

          {event.location ? (
            <PlaceLocation
              kind="event"
              title={event.title}
              location={event.location}
              withMap={withMap}
            />
          ) : null}
        </div>
      </div>

      {event.ended ? null : (
        <NearbyPlaces tenantId={tenantId} title={event.title} places={extras.nearby} />
      )}
      <NearbyNotice targets={targets} radius={nearbyRadiusOf(view.resolved.presentation)} />
    </article>
  );
}
