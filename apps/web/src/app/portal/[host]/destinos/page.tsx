import { nearbyRadiusOf, PORTAL_PATHS } from "@rikuy/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { portalDestinations, portalNearbyTargets } from "@/server/portal-content";
import { portalView } from "@/server/portal-view";

import { DestinationCard } from "../destination-card";
import { LocationButton, NearbyNotice, ProximityList, ProximityNote } from "../visitor-location";

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
  const [destinations, targets] = await Promise.all([
    portalDestinations(view),
    portalNearbyTargets(view),
  ]);

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
      <h1 className="portal-page-title">Destinos</h1>
      <p className="portal-lead">
        Lugares para visitar en {view.resolved.presentation.identity.siteName}.
      </p>
      {destinations.length === 0 ? (
        <p className="portal-empty">Pronto publicaremos aquí los lugares para visitar.</p>
      ) : (
        <>
          <div className="portal-list-tools">
            <LocationButton label="Ordenar por cercanía" />
            <ProximityNote />
          </div>
          <ProximityList
            className="portal-cards"
            entries={destinations.map((destination, index) => ({
              key: destination.slug,
              point: destination.location,
              node: (
                <DestinationCard
                  tenantId={view.context.tenant.tenantId}
                  destination={destination}
                  headingLevel={2}
                  priority={index < 2}
                />
              ),
            }))}
          />
          <NearbyNotice targets={targets} radius={nearbyRadiusOf(view.resolved.presentation)} />
        </>
      )}
    </div>
  );
}
