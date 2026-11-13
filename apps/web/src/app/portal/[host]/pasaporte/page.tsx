import { PORTAL_PATHS } from "@rikuy/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { portalPassport } from "@/server/portal-content";
import { portalView } from "@/server/portal-view";

import "../passport.css";
import { PassportHowItWorks } from "../passport-how";
import { CircuitProgressLine, PassportSummary } from "../passport-progress";

interface PassportPageProps {
  readonly params: Promise<{ host: string }>;
}

export async function generateMetadata({ params }: PassportPageProps): Promise<Metadata> {
  const view = await portalView((await params).host);
  if (view === null) return {};
  const { siteName } = view.resolved.presentation.identity;
  const description = `Circuitos de lugares para recorrer en ${siteName} y el premio por completarlos.`;
  return {
    title: "Pasaporte turístico",
    description,
    alternates: { canonical: PORTAL_PATHS.passport },
    openGraph: { title: `Pasaporte turístico | ${siteName}`, description },
  };
}

/** The tourist passport (C2, ADR-056): the municipality's published circuits. */
export default async function PassportPage({ params }: PassportPageProps) {
  const view = await portalView((await params).host);
  if (view === null) notFound();
  const circuits = await portalPassport(view);

  return (
    <div className="portal-page">
      <nav aria-label="Ruta de navegación" className="portal-breadcrumb">
        <ol>
          <li>
            <a href="/">Inicio</a>
          </li>
          <li aria-current="page">Pasaporte turístico</li>
        </ol>
      </nav>
      <h1 className="portal-page-title">Pasaporte turístico</h1>
      <p className="portal-lead">
        Recorre los lugares de un circuito de {view.resolved.presentation.identity.siteName} y
        llévate el premio del municipio.
      </p>
      {circuits.length > 0 ? <PassportSummary /> : null}
      {circuits.length === 0 ? (
        <p className="portal-empty">Pronto publicaremos aquí los circuitos del pasaporte.</p>
      ) : (
        <ul className="passport-circuits">
          {circuits.map((circuit) => (
            <li key={circuit.slug} className="passport-circuit">
              <h2 className="passport-circuit-name">
                <a href={PORTAL_PATHS.passportCircuit(circuit.slug)}>{circuit.name}</a>
              </h2>
              {circuit.summary ? <p>{circuit.summary}</p> : null}
              <p className="passport-circuit-meta">
                {circuit.stops.length} lugares: {circuit.stops.map((stop) => stop.title).join(", ")}
              </p>
              {circuit.reward ? (
                <p className="passport-reward">
                  <strong>Premio:</strong> {circuit.reward}
                </p>
              ) : null}
              <CircuitProgressLine stopIds={circuit.stops.map((stop) => stop.id)} />
            </li>
          ))}
        </ul>
      )}
      <PassportHowItWorks />
    </div>
  );
}
