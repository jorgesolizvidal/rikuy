import {
  PORTAL_PATHS,
  type HomeFigure,
  type PublishedDestinationSummary,
  type PublishedEventSummary,
} from "@rikuy/core";

import { responsiveImage } from "@/server/portal-content";

import { AssistantInvite } from "./assistant-invite";
import { Contour } from "./contour";
import { CardFlags, DestinationCard, type CardBadges } from "./destination-card";
import { EventCard } from "./event-card";
import { PassportSummary } from "./passport-progress";
import { PortalImage } from "./portal-image";

/**
 * The sections of the portal's home (ADR-062). Each one shows only what the municipality has
 * published; the page decides which ones, in which order and variant, from its brand.
 */

const HERO_SIZES = "(min-width: 60rem) 34rem, 100vw";

export interface HeroProps {
  readonly tenantId: string;
  readonly siteName: string;
  readonly tagline: string;
  readonly description: string;
  /** The destination whose photo is the cover, or null for the text cover. */
  readonly destination: PublishedDestinationSummary | null;
  readonly destinationHasTour: boolean;
  /** «Recorrido 360°» button when the general tour exists. */
  readonly tours: number;
  readonly agenda: boolean;
}

/** The cover: the portal's name, its words and the way in; with a destination's photo. */
export function HomeHero(props: HeroProps) {
  const photo = props.destination?.cover ? props.destination : null;
  const actions = (
    <div className="home-hero-actions">
      {props.tours > 0 ? (
        <a className="portal-button portal-button-primary" href={PORTAL_PATHS.generalTour}>
          Empezar el recorrido 360°
        </a>
      ) : null}
      <a
        className={props.tours > 0 ? "portal-button" : "portal-button portal-button-primary"}
        href={PORTAL_PATHS.destinations}
      >
        Ver los lugares
      </a>
      {props.agenda ? (
        <a className="portal-button" href={PORTAL_PATHS.agenda}>
          Ver la agenda
        </a>
      ) : null}
    </div>
  );
  const text = (
    <div className="portal-hero-text">
      {props.tagline ? <p className="portal-kicker">{props.tagline}</p> : null}
      <h1 id="portal-title">{props.siteName}</h1>
      {props.description ? <p className="portal-intro">{props.description}</p> : null}
      {actions}
    </div>
  );

  if (photo?.cover) {
    return (
      <section className="portal-hero" data-variant="photo" aria-labelledby="portal-title">
        {text}
        <a className="home-hero-photo" href={PORTAL_PATHS.destination(photo.slug)}>
          <PortalImage
            image={responsiveImage(props.tenantId, photo.cover)}
            sizes={HERO_SIZES}
            // The largest element of the page on a phone and on a computer (LCP).
            priority
          />
          <CardFlags tour={props.destinationHasTour} />
          <span className="home-hero-caption">
            <span className="home-hero-place">{photo.title}</span>
            <span className="home-hero-more">Ver el lugar</span>
          </span>
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
export function FiguresBand({ figures }: { readonly figures: readonly HomeFigure[] }) {
  if (figures.length === 0) return null;
  return (
    <section className="home-figures" aria-label="En cifras">
      <ul>
        {figures.map((figure) => (
          <li key={`${figure.value} ${figure.label}`}>
            <span className="home-figure-value">{figure.value}</span>
            <span className="home-figure-label">{figure.label}</span>
          </li>
        ))}
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
        <p className="portal-kicker">Desde tu celular o tu computadora</p>
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

export function PassportBanner({
  circuits,
  headingLevel = 2,
}: {
  readonly circuits: number;
  readonly headingLevel?: 2 | 3;
}) {
  if (circuits === 0) return null;
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section className="home-banner" data-kind="passport" aria-labelledby="pasaporte">
      <div className="home-banner-text">
        <p className="portal-kicker">Sellos con código QR</p>
        <Heading id="pasaporte">Pasaporte turístico</Heading>
        <p>
          Visita los lugares de un circuito, sella tu pasaporte con el código QR de cada uno y
          llévate el premio del municipio.
        </p>
        <PassportSummary />
        <a className="portal-button portal-button-primary" href={PORTAL_PATHS.passport}>
          {circuits === 1 ? "Ver el circuito" : `Ver los ${String(circuits)} circuitos`}
        </a>
      </div>
      <svg className="home-banner-seal" aria-hidden="true" viewBox="0 0 120 120" focusable="false">
        <circle cx="60" cy="60" r="54" fill="none" stroke="currentColor" strokeWidth="3" />
        <circle
          cx="60"
          cy="60"
          r="44"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="4 6"
        />
        <path
          d="m40 61 13 13 27-28"
          fill="none"
          stroke="currentColor"
          strokeWidth="7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
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
