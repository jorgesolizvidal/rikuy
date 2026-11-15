import { mapRoutePath, padBoundingBox, PORTAL_PATHS } from "@rikuy/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { portalPassport } from "@/server/portal-content";
import { portalHas, portalViewWith } from "@/server/portal-view";

import { CircuitReward } from "../../circuit-reward";
import { RouteMap } from "../../mini-map";
import "../../passport.css";
import { PassportHowItWorks } from "../../passport-how";
import { CircuitStamps } from "../../passport-progress";
import { QrScanner } from "../../qr-scanner";

interface CircuitPageProps {
  readonly params: Promise<{ host: string; slug: string }>;
}

async function circuitOf(params: CircuitPageProps["params"]) {
  const { host, slug } = await params;
  const view = await portalViewWith(host, "passport");
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

/**
 * One circuit of the passport (C3 · Paso 5, ADR-064): the progress ring and the prize, its stops
 * as round seals in the suggested order (the next one marked, none locked), the voucher, and the
 * route on a small map that loads only when the visitor gets to it.
 */
export default async function CircuitPage({ params }: CircuitPageProps) {
  const found = await circuitOf(params);
  if (found === null) notFound();
  const { view, circuit } = found;
  const located = circuit.stops.filter(
    (stop): stop is typeof stop & { location: { lat: number; lng: number } } =>
      stop.location !== null,
  );
  const withMap = located.length >= 2 && portalHas(view, "map");
  const route = located.map((stop, index) => ({
    key: `destination:${stop.slug}`,
    kind: "destination" as const,
    title: stop.title,
    href: PORTAL_PATHS.destination(stop.slug),
    detail: "",
    lat: stop.location.lat,
    lng: stop.location.lng,
    order: index + 1,
  }));

  return (
    <div className="portal-page passport-page">
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
      <header className="passport-head">
        <p className="portal-kicker">Circuito del pasaporte</p>
        <h1 className="portal-page-title">{circuit.name}</h1>
        {circuit.summary ? <p className="portal-lead">{circuit.summary}</p> : null}
        <div className="passport-head-actions">
          <QrScanner />
        </div>
      </header>

      <CircuitStamps
        circuit={circuit.slug}
        reward={circuit.reward}
        stops={circuit.stops.map((stop) => ({
          id: stop.id,
          slug: stop.slug,
          title: stop.title,
          href: PORTAL_PATHS.destination(stop.slug),
        }))}
      />
      <CircuitReward
        circuit={circuit.slug}
        reward={circuit.reward}
        stopIds={circuit.stops.map((stop) => stop.id)}
      />

      {withMap ? (
        <section className="passport-route" aria-labelledby="recorrido">
          <h2 id="recorrido">El recorrido</h2>
          <RouteMap
            stops={route}
            // Fitted to the stops (C3 · Paso 8): a walk of a few hundred meters fills the
            // map instead of sitting in the middle of 2 km.
            area={padBoundingBox(
              {
                west: Math.min(...route.map((stop) => stop.lng)),
                south: Math.min(...route.map((stop) => stop.lat)),
                east: Math.max(...route.map((stop) => stop.lng)),
                north: Math.max(...route.map((stop) => stop.lat)),
              },
              0.003,
              0.3,
            )}
          />
          <p>
            <a href={mapRoutePath(located.map((stop) => `destination:${stop.slug}`))}>
              Ver el recorrido en el mapa del municipio
            </a>
          </p>
        </section>
      ) : null}
      <PassportHowItWorks />
    </div>
  );
}
