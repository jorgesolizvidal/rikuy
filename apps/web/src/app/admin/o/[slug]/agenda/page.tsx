import { canEditContent, formatEventSchedule, loadAgenda, type EventListEntry } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";

import { adminSession } from "@/server/admin-session";
import { requireOrganization } from "@/server/organization";

import { SignOutButton } from "../../../sign-out-button";
import { NewDestinationForm } from "../destinos/new-destination-form";

export const metadata: Metadata = { title: "Agenda" };

const STATUS = {
  draft: { label: "Borrador", detail: "Nunca publicado" },
  published: { label: "Publicado", detail: "Sin cambios pendientes" },
  changed: { label: "Publicado", detail: "Con cambios sin publicar" },
} as const;

interface AgendaPageProps {
  readonly params: Promise<{ slug: string }>;
}

function EventTable({
  org,
  caption,
  events,
}: {
  readonly org: string;
  readonly caption: string;
  readonly events: readonly EventListEntry[];
}) {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Evento</th>
            <th scope="col">Cuándo</th>
            <th scope="col">Estado</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.contentId}>
              <td>
                <Link href={`/o/${org}/agenda/${event.contentId}`}>{event.title}</Link>
                <span className="cell-detail">/{event.slug}</span>
              </td>
              <td>{event.schedule ? formatEventSchedule(event.schedule) : "Sin fecha"}</td>
              <td>
                <span className="status-pill" data-status={event.status}>
                  {STATUS[event.status].label}
                </span>
                <span className="cell-detail">{STATUS[event.status].detail}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function AgendaPage({ params }: AgendaPageProps) {
  const membership = await requireOrganization((await params).slug);
  const agenda = await loadAgenda(membership, (await adminSession()).content);
  const canEdit = canEditContent(membership.role);
  const empty = agenda.upcoming.length + agenda.undated.length + agenda.past.length === 0;

  return (
    <main className="shell shell-wide">
      <header className="admin-header">
        <Link href={`/o/${membership.slug}`} className="eyebrow">
          ← {membership.displayName}
        </Link>
        <SignOutButton />
      </header>
      <div className="branding-heading">
        <h1 className="title title-sm">Agenda</h1>
        <p className="lead">
          Ferias, fiestas y actividades de {membership.displayName}. Un evento publicado aparece en
          el portal hasta que termina; después sale de la agenda solo.
        </p>
      </div>

      {canEdit ? (
        <section aria-labelledby="nuevo-evento" className="members-invite">
          <h2 id="nuevo-evento">Nuevo evento</h2>
          <NewDestinationForm org={membership.slug} kind="event" />
        </section>
      ) : (
        <p className="notice" role="status">
          Tu rol puede ver la agenda, pero no crear ni cambiar eventos.
        </p>
      )}

      {empty ? (
        <p className="notice">Todavía no hay eventos. Crea el primero con su nombre.</p>
      ) : null}

      {agenda.upcoming.length > 0 ? (
        <section aria-labelledby="proximos" className="agenda-section">
          <h2 id="proximos">Próximos y en curso</h2>
          <EventTable org={membership.slug} caption="Próximos eventos" events={agenda.upcoming} />
        </section>
      ) : null}
      {agenda.undated.length > 0 ? (
        <section aria-labelledby="sin-fecha" className="agenda-section">
          <h2 id="sin-fecha">Sin fecha</h2>
          <EventTable org={membership.slug} caption="Eventos sin fecha" events={agenda.undated} />
        </section>
      ) : null}
      {agenda.past.length > 0 ? (
        <section aria-labelledby="pasados" className="agenda-section">
          <h2 id="pasados">Pasados</h2>
          <p className="field-hint">
            Ya no aparecen en la agenda del portal; su página sigue en línea.
          </p>
          <EventTable org={membership.slug} caption="Eventos pasados" events={agenda.past} />
        </section>
      ) : null}
    </main>
  );
}
