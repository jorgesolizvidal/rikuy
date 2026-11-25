import {
  nearbyRadiusOf,
  PORTAL_PATHS,
  destinationJsonLd,
  directionsUrl,
  openingHoursLines,
  serializeJsonLd,
  storiesOfPlace,
  tourPath,
} from "@rikuy/core";
import type { Metadata } from "next";

import { RichTextView } from "@/components/rich-text";
import {
  movedOrNotFound,
  portalDestination,
  portalNearbyTargets,
  portalOpeningHours,
  portalOrigin,
  portalHasTour,
  portalPlaceExtras,
  responsiveImage,
  placeNoticeView,
  portalStories,
} from "@/server/portal-content";
import { portalHas, portalView } from "@/server/portal-view";

import "../../detail.css";
import { DetailHero } from "../../detail-hero";
import { OpenNow } from "../../open-now";
import { PhotoGallery } from "../../photo-gallery";
import { EventsHere, NearbyPlaces, PlaceLocation, VisitorDistance } from "../../place-sections";
import { ActionIcon } from "../../action-icon";
import { ShareButton } from "../../share-button";
import { PlaceNotices } from "../../notice-strip";
import { NearbyNotice } from "../../visitor-location";
import { PlaceStories } from "../../place-stories";

interface DestinationPageProps {
  readonly params: Promise<{ host: string; slug: string }>;
}

async function load(params: DestinationPageProps["params"]) {
  const { host, slug } = await params;
  const view = await portalView(host);
  if (view === null) return null;
  const destination = await portalDestination(view, decodeURIComponent(slug));
  return destination ? { view, destination } : null;
}

export async function generateMetadata({ params }: DestinationPageProps): Promise<Metadata> {
  const loaded = await load(params);
  if (loaded === null) return {};
  const { view, destination } = loaded;
  const cover = destination.cover
    ? responsiveImage(view.context.tenant.tenantId, destination.cover)
    : null;
  const description = destination.summary || undefined;
  return {
    title: destination.title,
    ...(description ? { description } : {}),
    alternates: { canonical: PORTAL_PATHS.destination(destination.slug) },
    openGraph: {
      type: "article",
      title: destination.title,
      ...(description ? { description } : {}),
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

export default async function DestinationPage({ params }: DestinationPageProps) {
  const loaded = await load(params);
  if (loaded === null) return movedOrNotFound(params, "destination", PORTAL_PATHS.destination);
  const { view, destination } = loaded;
  const [targets, tour, allHours, extras, notices, stories] = await Promise.all([
    portalNearbyTargets(view),
    portalHasTour(view, "destination", destination.slug),
    // Without the hours the page still shows: they are one more part of the visit card.
    portalOpeningHours(view).catch(() => new Map()),
    portalPlaceExtras(view, {
      kind: "destination",
      slug: destination.slug,
      location: destination.location,
    }),
    placeNoticeView(view, "destination", destination.slug),
    portalStories(view),
  ]);
  const hours = allHours.get(destination.slug) ?? null;
  const withMap = portalHas(view, "map");
  const tenantId = view.context.tenant.tenantId;
  const { siteName } = view.resolved.presentation.identity;
  const url = `${portalOrigin(view)}${PORTAL_PATHS.destination(destination.slug)}`;
  const cover = destination.cover ? responsiveImage(tenantId, destination.cover) : null;
  const updated = new Intl.DateTimeFormat(view.context.tenant.defaultLocale, {
    dateStyle: "long",
    timeZone: view.context.tenant.timezone,
  }).format(new Date(destination.updatedAt));
  const jsonLd = serializeJsonLd(
    destinationJsonLd(destination, {
      url,
      imageUrl: cover ? `${portalOrigin(view)}${cover.largest.url}` : null,
      portalName: siteName,
    }),
  );

  return (
    <article className="portal-page portal-detail">
      <script
        type="application/ld+json"
        // JSON built by us from validated data; `<` is escaped so it cannot end the tag.
        dangerouslySetInnerHTML={{ __html: jsonLd }}
      />
      <nav aria-label="Ruta de navegación" className="portal-breadcrumb">
        <ol>
          <li>
            <a href="/">Inicio</a>
          </li>
          <li>
            <a href={PORTAL_PATHS.destinations}>Destinos</a>
          </li>
          <li aria-current="page">{destination.title}</li>
        </ol>
      </nav>

      <DetailHero
        title={destination.title}
        category={extras.category}
        cover={cover}
        tour={tour}
        stamp={extras.circuits.length > 0}
      />

      <div className="portal-detail-grid">
        {destination.summary ? (
          <p className="portal-lead portal-detail-lead">{destination.summary}</p>
        ) : null}

        <aside className="portal-visit" aria-labelledby="para-tu-visita">
          <h2 id="para-tu-visita">Para tu visita</h2>
          <PlaceNotices notices={notices.notices} initial={notices.initial} />
          {hours ? (
            <section aria-labelledby="horario" className="portal-hours">
              <h3 id="horario">Horario</h3>
              <OpenNow hours={hours} timezone={view.context.tenant.timezone} />
              <dl className="portal-hours-week">
                {openingHoursLines(hours).map((line) => (
                  <div key={line.days}>
                    <dt>{line.days}</dt>
                    <dd>{line.times}</dd>
                  </div>
                ))}
              </dl>
              {hours.note ? <p className="portal-hours-note">{hours.note}</p> : null}
            </section>
          ) : null}
          {destination.location ? <VisitorDistance location={destination.location} /> : null}
          <div className="portal-actions">
            {destination.location ? (
              <a
                className="portal-button portal-button-primary"
                data-visit="directions"
                href={directionsUrl(destination.location)}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ActionIcon name="directions" />
                Cómo llegar<span className="visually-hidden"> (abre la app de mapas)</span>
              </a>
            ) : null}
            {tour ? (
              <a
                className="portal-button portal-tour-link"
                href={tourPath("destination", destination.slug)}
              >
                <ActionIcon name="tour" />
                <span className="visually-hidden">Ver el </span>Tour 360°
              </a>
            ) : null}
            <ShareButton title={destination.title} url={url} />
          </div>
          {extras.circuits.length > 0 ? (
            <section aria-labelledby="sello" className="portal-visit-stamp">
              <h3 id="sello">Sello del pasaporte</h3>
              <p>
                Este lugar es parada de{" "}
                {extras.circuits.map((circuit, index) => (
                  <span key={circuit.slug}>
                    {index > 0 ? (index === extras.circuits.length - 1 ? " y " : ", ") : null}
                    <a href={PORTAL_PATHS.passportCircuit(circuit.slug)}>{circuit.name}</a>
                  </span>
                ))}
                . Sella tu pasaporte con el código QR que está en el lugar.
              </p>
            </section>
          ) : null}
        </aside>

        <div className="portal-detail-main">
          {destination.body.length > 0 ? (
            <div className="portal-prose">
              <RichTextView blocks={destination.body} />
            </div>
          ) : null}

          {destination.gallery.length > 0 ? (
            <PhotoGallery
              photos={destination.gallery.map((image) => responsiveImage(tenantId, image))}
            />
          ) : null}

          <EventsHere events={extras.eventsHere} />

          <PlaceStories stories={storiesOfPlace(stories, destination.slug)} />

          {destination.location ? (
            <PlaceLocation
              kind="destination"
              title={destination.title}
              location={destination.location}
              withMap={withMap}
            />
          ) : null}

          <footer className="portal-destination-meta">
            <p>Actualizado el {updated}.</p>
          </footer>
        </div>
      </div>

      <NearbyPlaces tenantId={tenantId} title={destination.title} places={extras.nearby} />
      <NearbyNotice targets={targets} radius={nearbyRadiusOf(view.resolved.presentation)} />
    </article>
  );
}
