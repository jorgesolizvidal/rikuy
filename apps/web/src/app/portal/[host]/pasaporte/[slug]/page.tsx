import { mapRoutePath, PORTAL_PATHS } from "@rikuy/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { portalPassport } from "@/server/portal-content";
import { portalView } from "@/server/portal-view";

import { DestinationCard } from "../../destination-card";
import "../../passport.css";
import { PassportHowItWorks } from "../../passport-how";

interface CircuitPageProps {
  readonly params: Promise<{ host: string; slug: string }>;
}

async function circuitOf(params: CircuitPageProps["params"]) {
  const { host, slug } = await params;
  const view = await portalView(host);
  if (view === null) return null;
  const decoded = decodeURIComponent(slug);
  const circuit = (await portalPassport(view)).find((item) => item.slug === decoded) ?? null;
  return circuit ? { view, circuit } : null;
}

export async function generateMetadata({ params }: CircuitPageProps): Promise<Metadata> {
  const found = await circuitOf(params);
  if (found === null) return {};
  const { view, circuit } = found;
  const { siteName } = view.resolved.presentation.identity;
  const description =
    circuit.summary ||
    `Un circuito de ${circuit.stops.length} lugares del pasaporte turístico de ${siteName}.`;
  return {
    title: circuit.name,
    description,
    alternates: { canonical: PORTAL_PATHS.passportCircuit(circuit.slug) },
    openGraph: { title: `${circuit.name} | ${siteName}`, description },
  };
}

/** One circuit of the passport: its stops in the suggested order and its prize. */
export default async function CircuitPage({ params }: CircuitPageProps) {
  const found = await circuitOf(params);
  if (found === null) notFound();
  const { view, circuit } = found;
  const located = circuit.stops.filter((stop) => stop.location !== null);

  return (
    <div className="portal-page">
      <nav aria-label="Ruta de navegación" className="portal-breadcrumb">
        <ol>
          <li>
            <a href="/">Inicio</a>
          </li>
          <li>
            <a href={PORTAL_PATHS.passport}>Pasaporte turístico</a>
          </li>
          <li aria-current="page">{circuit.name}</li>
        </ol>
      </nav>
      <h1 className="portal-page-title">{circuit.name}</h1>
      {circuit.summary ? <p className="portal-lead">{circuit.summary}</p> : null}
      {circuit.reward ? (
        <p className="passport-reward passport-reward-lead">
          <strong>Premio al completarlo:</strong> {circuit.reward}
        </p>
      ) : null}
      <h2 className="passport-stops-title">{circuit.stops.length} lugares, en el orden sugerido</h2>
      {located.length >= 2 ? (
        <p className="passport-map-link">
          <a href={mapRoutePath(located.map((stop) => `destination:${stop.slug}`))}>
            Ver el recorrido en el mapa
          </a>
        </p>
      ) : null}
      <ol className="portal-cards passport-stops">
        {circuit.stops.map((stop, index) => (
          <DestinationCard
            key={stop.slug}
            tenantId={view.context.tenant.tenantId}
            destination={stop}
            headingLevel={3}
            priority={index < 2}
          />
        ))}
      </ol>
      <PassportHowItWorks />
    </div>
  );
}
