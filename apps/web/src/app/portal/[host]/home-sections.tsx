import {
  PORTAL_PATHS,
  type BandFigure,
  type FigureKind,
  type PublishedDestinationSummary,
  type PublishedEventSummary,
} from "@rikuy/core";

import { heroImage } from "@/server/portal-content";

import { AssistantInvite } from "./assistant-invite";
import { Contour } from "./contour";
import { DestinationCard, type CardBadges } from "./destination-card";
import { EventCard } from "./event-card";
import { PassportSummary } from "./passport-progress";
import { PortalImage } from "./portal-image";

/**
 * The sections of the portal's home (ADR-062). Each one shows only what the municipality has
 * published; the page decides which ones, in which order and variant, from its brand.
 */

/** The cover photo fills the window's width, edge to edge. */
const HERO_SIZES = "100vw";

export interface HeroProps {
  readonly tenantId: string;
  readonly siteName: string;
  readonly tagline: string;
  readonly description: string;
  /** The destination whose photo is the cover, or null for the text cover. */
  readonly destination: PublishedDestinationSummary | null;
  /** «Empezar el recorrido 360°» when the general tour exists. */
  readonly tours: number;
}

/**
 * The cover (C3 · Paso 8): the portal's name and its tagline over a destination's photo, and
 * one way in. The menu already has every section, so the cover does not repeat them: the
 * general tour when there is one, else the places. The photo names its place in a small
 * link (the place is also in the list below, so no card of its own).
 */
export function HomeHero(props: HeroProps) {
  const photo = props.destination?.cover ? props.destination : null;
  const action =
    props.tours > 0 ? (
      <a className="portal-button portal-button-primary" href={PORTAL_PATHS.generalTour}>
        Empezar el recorrido 360°
      </a>
    ) : (
      <a className="portal-button portal-button-primary" href={PORTAL_PATHS.destinations}>
        Ver los lugares
      </a>
    );
  const text = (
    <div className="portal-hero-text">
      <h1 id="portal-title">{props.siteName}</h1>
      {props.tagline ? (
        <p className="portal-tagline">{props.tagline}</p>
      ) : props.description ? (
        <p className="portal-intro">{props.description}</p>
      ) : null}
      <div className="home-hero-actions">{action}</div>
    </div>
  );

  if (photo?.cover) {
    return (
      <section className="portal-hero" data-variant="photo" aria-labelledby="portal-title">
        <div className="home-hero-photo">
          <PortalImage
            image={heroImage(props.tenantId, photo.cover)}
            sizes={HERO_SIZES}
            // The largest element of the page on a phone and on a computer (LCP).
            priority
          />
        </div>
        {text}
        <a className="home-hero-credit" href={PORTAL_PATHS.destination(photo.slug)}>
          <span className="visually-hidden">Foto: </span>
          {photo.title}
        </a>
      </section>
    );
  }
  return (
    <section className="portal-hero" data-variant="text" aria-labelledby="portal-title">
      <Contour seed={props.tenantId} />
      {text}
    </section>
  );
}

/** «En cifras»: the municipality's own figures and what the portal counts by itself. */
/** Each figure's icon (24-unit outline paths) and where it leads (ADR-068). */
const FIGURE_ICONS: Readonly<Record<FigureKind, string>> = {
  destinations:
    "M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
  tours: "M3 12c0-2.2 4-4 9-4s9 1.8 9 4-4 4-9 4M8.5 15.6 12 16l-2.6 2.6M12 8V4",
  events: "M5 6h14v14H5zM5 10h14M9 4v4M15 4v4",
  circuits:
    "M8 4h8v4a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 3M16 6h3a3 3 0 0 1-3 3M12 12v4M8 20h8M9 16h6",
  own: "M12 4.5l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L4.8 9.8l5-.7z",
};

const FIGURE_HREF: Readonly<Record<FigureKind, string | null>> = {
  destinations: PORTAL_PATHS.destinations,
  tours: PORTAL_PATHS.generalTour,
  events: PORTAL_PATHS.agenda,
  circuits: PORTAL_PATHS.passport,
  own: null,
};

/**
 * The figures (ADR-068): one white card with up to four figures, each with its icon, its
 * number and what it counts. What the portal counts leads to its section; the municipality's
 * own figures are only text. Right after a photo cover, the card rests on its lower edge.
 */
export function FiguresBand({ figures }: { readonly figures: readonly BandFigure[] }) {
  if (figures.length === 0) return null;
  return (
    <section className="home-figures" aria-label="En cifras">
      <ul data-count={figures.length}>
        {figures.map((figure) => {
          const href = FIGURE_HREF[figure.kind];
          const body = (
            <>
              <span className="home-figure-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="22" height="22" focusable="false">
                  <path
                    d={FIGURE_ICONS[figure.kind]}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span className="home-figure-text">
                <span className="home-figure-value">{figure.value}</span>
                <span className="home-figure-label">{figure.label}</span>
              </span>
              {href ? (
                <svg
                  className="home-figure-go"
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  focusable="false"
                >
                  <path
                    d="m9 6 6 6-6 6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : null}
            </>
          );
          return (
            <li key={`${figure.value} ${figure.label}`} data-kind={figure.kind}>
              {href ? (
                <a className="home-figure" href={href}>
                  {body}
                </a>
              ) : (
                <div className="home-figure">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function DestinationsSection({
  tenantId,
  destinations,
  variant,
  badgesOf,
  heroSlug,
}: {
  readonly tenantId: string;
  readonly destinations: readonly PublishedDestinationSummary[];
  readonly variant: string;
  readonly badgesOf: (slug: string) => CardBadges;
  /** The cover's destination: its photo is already loading first. */
  readonly heroSlug: string | null;
}) {
  if (destinations.length === 0) return null;
  const featured = variant === "featured";
  const shown = destinations.slice(0, featured ? 5 : 6);
  return (
    <section className="portal-section" aria-labelledby="destinos">
      <div className="portal-section-head">
        <h2 id="destinos">Lugares para visitar</h2>
        <a href={PORTAL_PATHS.destinations}>
          {destinations.length > shown.length
            ? `Ver los ${String(destinations.length)} destinos`
            : "Ver todos"}
        </a>
      </div>
      <ul className="portal-cards" data-variant={variant}>
        {shown.map((destination, index) => (
          <DestinationCard
            key={destination.slug}
            tenantId={tenantId}
            destination={destination}
            badges={badgesOf(destination.slug)}
            featured={featured && index === 0}
            // Without a photo cover, the first card is what a phone waits for (LCP).
            priority={heroSlug === null && index === 0}
          />
        ))}
      </ul>
    </section>
  );
}

export function EventsSection({
  tenantId,
  events,
  variant,
  badgesOf,
}: {
  readonly tenantId: string;
  readonly events: readonly PublishedEventSummary[];
  readonly variant: string;
  readonly badgesOf: (slug: string) => CardBadges;
}) {
  if (events.length === 0) return null;
  const cards = variant === "cards";
  return (
    <section className="portal-section" aria-labelledby="eventos">
      <div className="portal-section-head">
        <h2 id="eventos">Próximos eventos</h2>
        <a href={PORTAL_PATHS.agenda}>Ver la agenda</a>
      </div>
      <ul className="portal-events" data-layout={cards ? "cards" : "list"}>
        {events.slice(0, 3).map((event) => (
          <EventCard
            key={event.slug}
            event={event}
            photo={cards ? { tenantId } : null}
            badges={badgesOf(event.slug)}
          />
        ))}
      </ul>
    </section>
  );
}

/** Background photo of a banner: decorative, loaded late. */
interface BannerPhoto {
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

export function ToursBanner({
  tours,
  photo,
}: {
  readonly tours: number;
  readonly photo: BannerPhoto | null;
}) {
  if (tours === 0) return null;
  return (
    <section className="home-banner" data-kind="tours" aria-labelledby="recorridos">
      {photo ? (
        // eslint-disable-next-line @next/next/no-img-element -- published, versioned preview
        <img
          className="home-banner-photo"
          src={photo.url}
          width={photo.width}
          height={photo.height}
          alt=""
          loading="lazy"
          decoding="async"
        />
      ) : null}
      <div className="home-banner-text">
        <h2 id="recorridos">Recorridos 360°</h2>
        <p>
          {tours === 1
            ? "Recorre un lugar en 360° antes de viajar, o mientras estás aquí."
            : `Recorre ${String(tours)} lugares en 360° antes de viajar, o mientras estás aquí.`}
        </p>
        <a className="portal-button portal-button-primary" href={PORTAL_PATHS.generalTour}>
          {tours === 1 ? "Abrir el recorrido" : `Recorrer los ${String(tours)} lugares`}
        </a>
      </div>
    </section>
  );
}

export function PassportBanner({ circuits }: { readonly circuits: number }) {
  if (circuits === 0) return null;
  return (
    <section className="home-banner" data-kind="passport" aria-labelledby="pasaporte">
      <div className="home-banner-text">
        <h2 id="pasaporte">Pasaporte turístico</h2>
        <p>
          Sella con el código QR de cada lugar de un circuito y llévate el premio del municipio.
        </p>
        <PassportSummary />
      </div>
      <a className="portal-button portal-button-primary" href={PORTAL_PATHS.passport}>
        {circuits === 1 ? "Ver el circuito" : `Ver los ${String(circuits)} circuitos`}
      </a>
    </section>
  );
}

export function AssistantBanner({
  name,
  named,
}: {
  readonly name: string;
  readonly named: boolean;
}) {
  return (
    <section className="home-banner" data-kind="assistant" aria-labelledby="pregunta">
      <div className="home-banner-text">
        <h2 id="pregunta">¿Tienes una pregunta?</h2>
        <p>
          {named ? name : "El asistente"} responde con lo que publica el municipio: lugares,
          eventos, horarios y cómo llegar.
        </p>
      </div>
      <AssistantInvite label={named ? `Preguntar a ${name}` : "Hacer una pregunta"} />
    </section>
  );
}
