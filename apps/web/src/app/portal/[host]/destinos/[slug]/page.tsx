import {
  nearbyRadiusOf,
  PORTAL_PATHS,
  destinationJsonLd,
  directionsUrl,
  formatCoordinates,
  openStreetMapUrl,
  serializeJsonLd,
  tourPath,
} from "@rikuy/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { RichTextView } from "@/components/rich-text";
import {
  portalDestination,
  portalNearbyTargets,
  portalOrigin,
  portalTour,
  responsiveImage,
} from "@/server/portal-content";
import { portalView } from "@/server/portal-view";

import { MiniMap } from "../../mini-map";
import { PortalImage } from "../../portal-image";
import { ShareButton } from "../../share-button";
import { DistanceText, LocationButton, NearbyNotice } from "../../visitor-location";

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

const COVER_SIZES = "(min-width: 72rem) 72rem, 100vw";
const GALLERY_SIZES = "(min-width: 72rem) 23rem, (min-width: 40rem) 45vw, 100vw";

export default async function DestinationPage({ params }: DestinationPageProps) {
  const loaded = await load(params);
  if (loaded === null) notFound();
  const { view, destination } = loaded;
  const [targets, tour] = await Promise.all([
    portalNearbyTargets(view),
    portalTour(view, "destination", destination.slug),
  ]);
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
      imageUrl: cover?.largest.url ?? null,
      portalName: siteName,
    }),
  );

  return (
    <article className="portal-page portal-destination">
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

      <header className="portal-destination-header">
        <h1 className="portal-page-title">{destination.title}</h1>
        {destination.summary ? <p className="portal-lead">{destination.summary}</p> : null}
      </header>

      {cover ? (
        <PortalImage className="portal-cover" image={cover} sizes={COVER_SIZES} priority />
      ) : null}

      <div className="portal-actions">
        {tour ? (
          <a
            className="portal-button portal-tour-link"
            href={tourPath("destination", destination.slug)}
          >
            Ver el tour 360°
          </a>
        ) : null}
        {destination.location ? (
          <a
            className="portal-button portal-button-primary"
            href={directionsUrl(destination.location)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Cómo llegar<span className="visually-hidden"> (abre la app de mapas)</span>
          </a>
        ) : null}
        <ShareButton title={destination.title} url={url} />
      </div>

      {destination.body.length > 0 ? (
        <div className="portal-prose">
          <RichTextView blocks={destination.body} />
        </div>
      ) : null}

      {destination.gallery.length > 0 ? (
        <section aria-labelledby="galeria" className="portal-gallery">
          <h2 id="galeria">Fotos</h2>
          <ul>
            {destination.gallery.map((image, index) => {
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

      {destination.location ? (
        <section aria-labelledby="ubicacion" className="portal-location">
          <h2 id="ubicacion">Ubicación</h2>
          <MiniMap
            point={{
              key: "here",
              kind: "destination",
              title: destination.title,
              href: "",
              detail: "",
              lat: destination.location.lat,
              lng: destination.location.lng,
            }}
          />
          <div className="portal-location-visitor">
            <DistanceText point={destination.location} />
            <LocationButton label="Ver a qué distancia estoy" />
          </div>
          <p>
            {formatCoordinates(destination.location)} ·{" "}
            <a
              href={`${PORTAL_PATHS.map}?lat=${destination.location.lat}&lng=${destination.location.lng}`}
            >
              Ver en el mapa del municipio
            </a>{" "}
            ·{" "}
            <a
              href={openStreetMapUrl(destination.location)}
              target="_blank"
              rel="noopener noreferrer"
            >
              OpenStreetMap
            </a>
          </p>
        </section>
      ) : null}

      <footer className="portal-destination-meta">
        <p>Actualizado el {updated}.</p>
      </footer>
      <NearbyNotice targets={targets} radius={nearbyRadiusOf(view.resolved.presentation)} />
    </article>
  );
}
