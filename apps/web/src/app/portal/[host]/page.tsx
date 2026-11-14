import "./listing.css";

import {
  assistantPersona,
  categoryBySlug,
  homeFigures,
  homeOf,
  visibleHomeSections,
  type HomeSectionKey,
  type PublishedDestinationSummary,
} from "@rikuy/core";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { aiGatewayStatus } from "@/server/ai-gateway";
import {
  portalBadges,
  portalDestinations,
  portalEvents,
  portalIndex,
  portalPassport,
  portalTourIndex,
} from "@/server/portal-content";
import { tourMenu } from "@/server/portal-tours";
import { portalHas, portalView } from "@/server/portal-view";

import {
  AssistantBanner,
  DestinationsSection,
  EventsSection,
  FiguresBand,
  HomeHero,
  PassportBanner,
  ToursBanner,
} from "./home-sections";

interface PortalPageProps {
  readonly params: Promise<{ host: string }>;
}

const PLACES_SOON = {
  title: "Lugares para visitar",
  text: "Fichas de cada destino con fotos, ubicación y cómo llegar.",
} as const;

const AGENDA_SOON = {
  title: "Agenda",
  text: "Ferias, fiestas y actividades con su fecha y lugar.",
} as const;

const TOURS_SOON = {
  title: "Recorridos 360°",
  text: "Recorre los sitios desde el celular antes de viajar.",
} as const;

/** The assistant, until this deployment has AI (then it is the floating button). */
const ASSISTANT_SOON = {
  title: "Guía local",
  text: "Pregunta qué hacer y recibe respuestas basadas en la información del municipio.",
} as const;

/** The cover: the destination the municipality chose, or the first one with a photo. */
function coverDestination(
  destinations: readonly PublishedDestinationSummary[],
  chosenSlug: string | null,
): PublishedDestinationSummary | null {
  const chosen = chosenSlug ? destinations.find((item) => item.slug === chosenSlug) : undefined;
  if (chosen?.cover) return chosen;
  return destinations.find((item) => item.cover !== null) ?? null;
}

export default async function PortalHomePage({ params }: PortalPageProps) {
  const view = await portalView((await params).host);
  if (view === null) notFound();

  const { presentation } = view.resolved;
  const { identity, seo } = presentation;
  const home = homeOf(presentation);
  const tenantId = view.context.tenant.tenantId;
  const [destinations, events, tours, circuits, index, badges] = await Promise.all([
    portalDestinations(view),
    portalEvents(view),
    portalTourIndex(view),
    portalPassport(view),
    portalIndex(view),
    portalBadges(view),
  ]);
  const has = (module: Parameters<typeof portalHas>[1]) => portalHas(view, module);
  const persona =
    aiGatewayStatus().configured && has("assistant") ? assistantPersona(presentation) : null;

  // The cover (ADR-062): with a photo only when a destination has one.
  const chosenSlug =
    home.hero.destinationId === null
      ? null
      : (index.find(
          (entry) => entry.kind === "destination" && entry.contentId === home.hero.destinationId,
        )?.slug ?? null);
  const cover = home.hero.variant === "photo" ? coverDestination(destinations, chosenSlug) : null;

  const destinationCategories = categoryBySlug(index, "destination");
  const eventCategories = categoryBySlug(index, "event");
  const startTour = tourMenu(tours.filter((entry) => entry.start).slice(0, 1))[0] ?? null;

  const sections: Readonly<Record<HomeSectionKey, () => ReactNode>> = {
    figures: () => (
      <FiguresBand
        figures={homeFigures(
          home.figures,
          {
            destinations: destinations.length,
            tours: tours.length,
            events: events.length,
            circuits: circuits.length,
          },
          has,
        )}
      />
    ),
    destinations: () => (
      <DestinationsSection
        tenantId={tenantId}
        destinations={destinations}
        variant={home.sections.find((section) => section.key === "destinations")?.variant ?? "grid"}
        heroSlug={cover?.slug ?? null}
        badgesOf={(slug) => ({
          category: destinationCategories.get(slug)?.name ?? null,
          tour: badges.tours.has(`destination:${slug}`),
          stamp: badges.stamps.has(`destination:${slug}`),
        })}
      />
    ),
    events: () => (
      <EventsSection
        tenantId={tenantId}
        events={events}
        variant={home.sections.find((section) => section.key === "events")?.variant ?? "list"}
        badgesOf={(slug) => ({
          category: eventCategories.get(slug)?.name ?? null,
          tour: badges.tours.has(`event:${slug}`),
        })}
      />
    ),
    tours: () => <ToursBanner tours={tours.length} photo={startTour ? startTour.preview : null} />,
    passport: () => <PassportBanner circuits={circuits.length} />,
    assistant: () =>
      persona ? <AssistantBanner name={persona.name} named={persona.named} /> : null,
  };

  // Only what this portal does not have yet (a new municipality shows all of it), and only
  // what its municipality has (ADR-060).
  const upcoming = [
    ...(destinations.length > 0 ? [] : [PLACES_SOON]),
    ...(events.length > 0 || !has("agenda") ? [] : [AGENDA_SOON]),
    ...(tours.length > 0 || !has("tours") ? [] : [TOURS_SOON]),
    ...(aiGatewayStatus().configured || !has("assistant") ? [] : [ASSISTANT_SOON]),
  ];

  return (
    <>
      <HomeHero
        tenantId={tenantId}
        siteName={identity.siteName}
        tagline={identity.tagline}
        description={seo.description}
        destination={cover}
        destinationHasTour={cover ? badges.tours.has(`destination:${cover.slug}`) : false}
        tours={tours.length}
        agenda={has("agenda") && events.length > 0}
      />

      {visibleHomeSections(home, has).map((section) => (
        <div key={section.key} className="home-section" data-section={section.key}>
          {sections[section.key]()}
        </div>
      ))}

      {upcoming.length > 0 ? (
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
      ) : null}
    </>
  );
}
