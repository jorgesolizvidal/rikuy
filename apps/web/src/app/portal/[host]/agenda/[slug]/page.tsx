import {
  nearbyRadiusOf,
  PORTAL_PATHS,
  directionsUrl,
  eventJsonLd,
  formatCoordinates,
  formatEventSchedule,
  openStreetMapUrl,
  serializeJsonLd,
} from "@rikuy/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { RichTextView } from "@/components/rich-text";
import {
  portalEvent,
  portalNearbyTargets,
  portalOrigin,
  responsiveImage,
} from "@/server/portal-content";
import { portalView } from "@/server/portal-view";

import { MiniMap } from "../../mini-map";
import { PortalImage } from "../../portal-image";
import { ShareButton } from "../../share-button";
import { DistanceText, LocationButton, NearbyNotice } from "../../visitor-location";

interface EventPageProps {
  readonly params: Promise<{ host: string; slug: string }>;
}

async function load(params: EventPageProps["params"]) {
  const { host, slug } = await params;
  const view = await portalView(host);
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

const COVER_SIZES = "(min-width: 72rem) 72rem, 100vw";
const GALLERY_SIZES = "(min-width: 72rem) 23rem, (min-width: 40rem) 45vw, 100vw";

export default async function EventPage({ params }: EventPageProps) {
  const loaded = await load(params);
  if (loaded === null) notFound();
  const { view, event } = loaded;
  const targets = await portalNearbyTargets(view);
  const tenantId = view.context.tenant.tenantId;
  const { siteName } = view.resolved.presentation.identity;
  const origin = portalOrigin(view);
  const url = `${origin}${PORTAL_PATHS.event(event.slug)}`;
  const cover = event.cover ? responsiveImage(tenantId, event.cover) : null;
  const jsonLd = serializeJsonLd(
    eventJsonLd(event, {
      url,
      imageUrl: cover?.largest.url ?? null,
      portalName: siteName,
      portalUrl: origin,
    }),
  );

  return (
    <article className="portal-page portal-destination">
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

      <header className="portal-destination-header">
        <h1 className="portal-page-title">{event.title}</h1>
        <p className="portal-event-headline">
          <time dateTime={event.schedule.allDay ? event.schedule.start : event.startsAt}>
            {formatEventSchedule(event.schedule)}
          </time>
          {event.venue ? (
            <>
              {" · "}
              <a href={PORTAL_PATHS.destination(event.venue.slug)}>{event.venue.title}</a>
            </>
          ) : null}
        </p>
        {event.ended ? (
          <p className="portal-ended" role="status">
            Este evento ya terminó. <a href={PORTAL_PATHS.agenda}>Ver los próximos eventos</a>.
          </p>
        ) : null}
        {event.summary ? <p className="portal-lead">{event.summary}</p> : null}
      </header>

      {cover ? (
        <PortalImage className="portal-cover" image={cover} sizes={COVER_SIZES} priority />
      ) : null}

      {event.ended ? null : (
        <div className="portal-actions">
          {event.location ? (
            <a
              className="portal-button portal-button-primary"
              href={directionsUrl(event.location)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Cómo llegar<span className="visually-hidden"> (abre la app de mapas)</span>
            </a>
          ) : null}
          <a
            className="portal-button"
            href={PORTAL_PATHS.eventCalendar(event.slug)}
            download={`${event.slug}.ics`}
          >
            Añadir al calendario
          </a>
          <ShareButton title={event.title} url={url} />
        </div>
      )}

      {event.body.length > 0 ? (
        <div className="portal-prose">
          <RichTextView blocks={event.body} />
        </div>
      ) : null}

      {event.gallery.length > 0 ? (
        <section aria-labelledby="galeria" className="portal-gallery">
          <h2 id="galeria">Fotos</h2>
          <ul>
            {event.gallery.map((image, index) => {
              const photo = responsiveImage(tenantId, image);
              return (
                <li key={`${image.assetId}-${index}`}>
                  <a href={photo.largest.url} className="portal-gallery-link">
                    <PortalImage image={photo} sizes={GALLERY_SIZES} />
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {event.location ? (
        <section aria-labelledby="ubicacion" className="portal-location">
          <h2 id="ubicacion">Ubicación</h2>
          <MiniMap
            point={{
              key: "here",
              kind: "event",
              title: event.title,
              href: "",
              detail: "",
              lat: event.location.lat,
              lng: event.location.lng,
            }}
          />
          <div className="portal-location-visitor">
            <DistanceText point={event.location} />
            <LocationButton label="Ver a qué distancia estoy" />
          </div>
          <p>
            {formatCoordinates(event.location)} ·{" "}
            <a href={`${PORTAL_PATHS.map}?lat=${event.location.lat}&lng=${event.location.lng}`}>
              Ver en el mapa del municipio
            </a>{" "}
            ·{" "}
            <a href={openStreetMapUrl(event.location)} target="_blank" rel="noopener noreferrer">
              OpenStreetMap
            </a>
          </p>
        </section>
      ) : null}

      <footer className="portal-destination-meta">
        <p>Fecha y hora del municipio.</p>
      </footer>
      <NearbyNotice targets={targets} radius={nearbyRadiusOf(view.resolved.presentation)} />
    </article>
  );
}
