import "../listing.css";

import { categoriesInUse, categoryBySlug, nearbyRadiusOf, PORTAL_PATHS } from "@rikuy/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  portalBadges,
  portalDestinations,
  portalIndex,
  portalNearbyTargets,
} from "@/server/portal-content";
import { portalHas, portalView } from "@/server/portal-view";

import { DestinationCard } from "../destination-card";
import { FilteredProximityList } from "../list-filter";
import { searchText } from "../list-search";
import { LocationButton, NearbyNotice, ProximityNote } from "../visitor-location";

interface DestinationsPageProps {
  readonly params: Promise<{ host: string }>;
}

export async function generateMetadata({ params }: DestinationsPageProps): Promise<Metadata> {
  const view = await portalView((await params).host);
  if (view === null) return {};
  const { siteName } = view.resolved.presentation.identity;
  const description = `Lugares para visitar en ${siteName}: fotos, ubicación y cómo llegar.`;
  return {
    title: "Destinos",
    description,
    alternates: { canonical: PORTAL_PATHS.destinations },
    openGraph: { title: `Destinos | ${siteName}`, description },
  };
}

export default async function DestinationsPage({ params }: DestinationsPageProps) {
  const view = await portalView((await params).host);
  if (view === null) notFound();
  const [destinations, targets, index, badges] = await Promise.all([
    portalDestinations(view),
    portalNearbyTargets(view),
    portalIndex(view),
    portalBadges(view),
  ]);
  const categories = categoriesInUse(index, "destination");
  const categoryOf = categoryBySlug(index, "destination");
  const slugOfCategory = new Map(categories.map((category) => [category.id, category.slug]));

  return (
    <div className="portal-page">
      <nav aria-label="Ruta de navegación" className="portal-breadcrumb">
        <ol>
          <li>
            <a href="/">Inicio</a>
          </li>
          <li aria-current="page">Destinos</li>
        </ol>
      </nav>
      <header className="portal-listing-head">
        <h1 className="portal-page-title">Destinos</h1>
        <p className="portal-lead">
          {destinations.length > 0
            ? `${String(destinations.length)} ${destinations.length === 1 ? "lugar" : "lugares"} para visitar: fotos, ubicación y cómo llegar.`
            : "Lugares para visitar: fotos, ubicación y cómo llegar."}
        </p>
      </header>
      {destinations.length === 0 ? (
        <p className="portal-empty">Pronto publicaremos aquí los lugares para visitar.</p>
      ) : (
        <>
          <div className="portal-list-tools">
            <LocationButton label="Ordenar por cercanía" />
            {portalHas(view, "map") ? (
              <a className="portal-button" href={PORTAL_PATHS.map}>
                Ver en el mapa
              </a>
            ) : null}
            <ProximityNote />
          </div>
          <FilteredProximityList
            className="portal-cards"
            categories={categories.map(({ slug, name }) => ({ slug, name }))}
            entries={destinations.map((destination, position) => {
              const category = categoryOf.get(destination.slug) ?? null;
              return {
                key: destination.slug,
                point: destination.location,
                category: category ? (slugOfCategory.get(category.id) ?? null) : null,
                text: searchText(destination.title, destination.summary, category?.name),
                node: (
                  <DestinationCard
                    tenantId={view.context.tenant.tenantId}
                    destination={destination}
                    headingLevel={2}
                    priority={position < 2}
                    badges={{
                      category: category?.name ?? null,
                      tour: badges.tours.has(`destination:${destination.slug}`),
                      stamp: badges.stamps.has(`destination:${destination.slug}`),
                    }}
                  />
                ),
              };
            })}
          />
          <NearbyNotice targets={targets} radius={nearbyRadiusOf(view.resolved.presentation)} />
        </>
      )}
    </div>
  );
}
