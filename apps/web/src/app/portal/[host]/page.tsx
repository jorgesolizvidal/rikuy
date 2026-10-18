import { notFound } from "next/navigation";

import { portalView } from "@/server/portal-view";

import { Contour } from "./contour";

interface PortalPageProps {
  readonly params: Promise<{ host: string }>;
}

const UPCOMING = [
  {
    title: "Lugares para visitar",
    text: "Fichas de cada destino con fotos, horarios y cómo llegar.",
  },
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

      <section className="portal-upcoming" aria-labelledby="pronto">
        <h2 id="pronto">Muy pronto en este portal</h2>
        <ul>
          {UPCOMING.map((item) => (
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
