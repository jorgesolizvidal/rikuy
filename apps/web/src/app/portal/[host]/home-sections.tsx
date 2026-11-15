import {
  PORTAL_PATHS,
  type HomeFigure,
  type PublishedDestinationSummary,
  type PublishedEventSummary,
} from "@rikuy/core";

import { responsiveImage } from "@/server/portal-content";

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
            image={responsiveImage(props.tenantId, photo.cover)}
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
