import { PORTAL_PATHS } from "@rikuy/core";
import { notFound } from "next/navigation";

import { portalDestinations, portalEvents, portalTourIndex } from "@/server/portal-content";
import { portalView } from "@/server/portal-view";

import { Contour } from "./contour";
import { DestinationCard } from "./destination-card";
import { EventCard } from "./event-card";

interface PortalPageProps {
  readonly params: Promise<{ host: string }>;
}

/** Destinations shown on the home page; the rest are one click away. */
const HOME_DESTINATIONS = 6;

const PLACES_SOON = {
  title: "Lugares para visitar",
  text: "Fichas de cada destino con fotos, ubicación y cómo llegar.",
} as const;

/** Next events shown on the home page. */
const HOME_EVENTS = 3;

const AGENDA_SOON = {
  title: "Agenda",
  text: "Ferias, fiestas y actividades con su fecha y lugar.",
} as const;

const TOURS_SOON = {
  title: "Recorridos 360°",
  text: "Recorre los sitios desde el celular antes de viajar.",
} as const;

/** What the platform will bring to every portal (P5). */
const UPCOMING = [
  {
    title: "Guía local",
    text: "Pregunta qué hacer y recibe respuestas basadas en la información del municipio.",
  },
] as const;

export default async function PortalHomePage({ params }: PortalPageProps) {
  const view = await portalView((await params).host);
  if (view === null) notFound();

  const { identity, seo } = view.resolved.presentation;
  const [destinations, events, tours] = await Promise.all([
    portalDestinations(view),
    portalEvents(view),
    portalTourIndex(view),
  ]);
  // Only what this portal does not have yet (a new municipality shows all of it).
  const upcoming = [
    ...(destinations.length > 0 ? [] : [PLACES_SOON]),
    ...(events.length > 0 ? [] : [AGENDA_SOON]),
    ...(tours.length > 0 ? [] : [TOURS_SOON]),
    ...UPCOMING,
  ];

  return (
    <>
      <section className="portal-hero" aria-labelledby="portal-title">
        <Contour seed={view.context.tenant.tenantId} />
        <div className="portal-hero-text">
          <h1 id="portal-title">{identity.siteName}</h1>
          {identity.tagline ? <p className="portal-tagline">{identity.tagline}</p> : null}
          {seo.description ? <p className="portal-intro">{seo.description}</p> : null}
        </div>
      </section>

      {destinations.length > 0 ? (
        <section className="portal-section" aria-labelledby="destinos">
          <div className="portal-section-head">
            <h2 id="destinos">Lugares para visitar</h2>
            {destinations.length > HOME_DESTINATIONS ? (
              <a href={PORTAL_PATHS.destinations}>Ver los {destinations.length} destinos</a>
            ) : (
              <a href={PORTAL_PATHS.destinations}>Ver todos</a>
            )}
          </div>
          <ul className="portal-cards">
            {destinations.slice(0, HOME_DESTINATIONS).map((destination) => (
              <DestinationCard
                key={destination.slug}
                tenantId={view.context.tenant.tenantId}
                destination={destination}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {events.length > 0 ? (
        <section className="portal-section" aria-labelledby="eventos">
          <div className="portal-section-head">
            <h2 id="eventos">Próximos eventos</h2>
            <a href={PORTAL_PATHS.agenda}>Ver la agenda</a>
          </div>
          <ul className="portal-events">
            {events.slice(0, HOME_EVENTS).map((event) => (
              <EventCard key={event.slug} event={event} />
            ))}
          </ul>
        </section>
      ) : null}

      {tours.length > 0 ? (
        <section className="portal-section" aria-labelledby="recorridos">
          <div className="portal-section-head">
            <h2 id="recorridos">Recorridos 360°</h2>
            <a href={PORTAL_PATHS.generalTour}>
              {tours.length === 1 ? "Abrir el recorrido" : `Recorrer los ${tours.length} lugares`}
            </a>
          </div>
          <p className="portal-section-text">{TOURS_SOON.text}</p>
        </section>
      ) : null}

      <section className="portal-upcoming" aria-labelledby="pronto">
        <h2 id="pronto">Muy pronto en este portal</h2>
        <ul>
          {upcoming.map((item) => (
            <li key={item.title}>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
