import { PORTAL_PATHS } from "@rikuy/core";
import { notFound } from "next/navigation";

import { portalDestinations } from "@/server/portal-content";
import { portalView } from "@/server/portal-view";

import { Contour } from "./contour";
import { DestinationCard } from "./destination-card";

interface PortalPageProps {
  readonly params: Promise<{ host: string }>;
}

/** Destinations shown on the home page; the rest are one click away. */
const HOME_DESTINATIONS = 6;

const PLACES_SOON = {
  title: "Lugares para visitar",
  text: "Fichas de cada destino con fotos, ubicación y cómo llegar.",
} as const;

const UPCOMING = [
  { title: "Agenda", text: "Ferias, fiestas y actividades con su fecha y lugar." },
  {
    title: "Recorridos 360°",
    text: "Recorre los sitios desde el celular antes de viajar.",
  },
  {
    title: "Guía local",
    text: "Pregunta qué hacer y recibe respuestas basadas en la información del municipio.",
  },
] as const;

export default async function PortalHomePage({ params }: PortalPageProps) {
  const view = await portalView((await params).host);
  if (view === null) notFound();

  const { identity, seo } = view.resolved.presentation;
  const destinations = await portalDestinations(view);
  const upcoming = destinations.length > 0 ? UPCOMING : [PLACES_SOON, ...UPCOMING];

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
