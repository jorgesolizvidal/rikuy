import { formatEventMonth, groupByMonth, PORTAL_PATHS } from "@rikuy/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { portalEvents } from "@/server/portal-content";
import { portalView } from "@/server/portal-view";

import { EventCard } from "../event-card";

interface AgendaPageProps {
  readonly params: Promise<{ host: string }>;
}

export async function generateMetadata({ params }: AgendaPageProps): Promise<Metadata> {
  const view = await portalView((await params).host);
  if (view === null) return {};
  const { siteName } = view.resolved.presentation.identity;
  const description = `Ferias, fiestas y actividades en ${siteName}: fecha, lugar y cómo llegar.`;
  return {
    title: "Agenda",
    description,
    alternates: { canonical: PORTAL_PATHS.agenda },
    openGraph: { title: `Agenda | ${siteName}`, description },
  };
}

export default async function AgendaPage({ params }: AgendaPageProps) {
  const view = await portalView((await params).host);
  if (view === null) notFound();
  const events = await portalEvents(view);
  const months = groupByMonth(events);

  return (
    <div className="portal-page">
      <nav aria-label="Ruta de navegación" className="portal-breadcrumb">
        <ol>
          <li>
            <a href="/">Inicio</a>
          </li>
          <li aria-current="page">Agenda</li>
        </ol>
      </nav>
      <h1 className="portal-page-title">Agenda</h1>
      <p className="portal-lead">
        Ferias, fiestas y actividades en {view.resolved.presentation.identity.siteName}. Las fechas
        y horas son las del municipio.
      </p>
      {months.length === 0 ? (
        <p className="portal-empty">No hay eventos próximos por ahora. Vuelve pronto.</p>
      ) : (
        months.map((month) => (
          <section
            key={month.monthKey}
            className="portal-month"
            aria-labelledby={`mes-${month.monthKey}`}
          >
            <h2 id={`mes-${month.monthKey}`}>{formatEventMonth(month.monthKey)}</h2>
            <ul className="portal-events">
              {month.items.map((event) => (
                <EventCard key={event.slug} event={event} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
