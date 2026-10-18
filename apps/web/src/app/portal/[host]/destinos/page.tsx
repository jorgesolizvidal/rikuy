import { PORTAL_PATHS } from "@rikuy/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { portalDestinations } from "@/server/portal-content";
import { portalView } from "@/server/portal-view";

import { DestinationCard } from "../destination-card";

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
  const destinations = await portalDestinations(view);

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
        <ul className="portal-cards">
          {destinations.map((destination, index) => (
            <DestinationCard
              key={destination.slug}
              tenantId={view.context.tenant.tenantId}
              destination={destination}
              headingLevel={2}
              priority={index < 2}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
