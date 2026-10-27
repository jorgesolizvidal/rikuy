import { loadGeneralTour, loadTours, PORTAL_PATHS } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";

import { adminSession } from "@/server/admin-session";
import { requireOrganization } from "@/server/organization";
import { platformSettings } from "@/server/platform";

import { SignOutButton } from "../../../sign-out-button";
import { PortalShare } from "../destinos/[id]/portal-share";
import { GeneralTourForm } from "./general-tour-form";
import { KIND, scenesLabel, TOUR_STATUS } from "./labels";
import { NewTourForm } from "./new-tour-form";

export const metadata: Metadata = { title: "Tours 360°" };

const DATE = new Intl.DateTimeFormat("es-BO", {
  dateStyle: "medium",
  timeStyle: "short",
  hour12: false,
  timeZone: "America/La_Paz",
});

interface ToursPageProps {
  readonly params: Promise<{ slug: string }>;
}

export default async function ToursPage({ params }: ToursPageProps) {
  const membership = await requireOrganization((await params).slug);
  const session = await adminSession();
  const [{ tours, candidates, canEdit }, general, hostname] = await Promise.all([
    loadTours(membership, {
      tours: session.tours,
      candidates: async () => {
        const [destinations, events] = await Promise.all([
          session.content.listDestinations(membership.tenantId),
          session.content.listEvents(membership.tenantId),
        ]);
        return [
          ...destinations.map((entry) => ({
            contentId: entry.contentId,
            kind: "destination" as const,
            title: entry.title,
          })),
          ...events
            .filter((entry) => !entry.ended)
            .map((entry) => ({
              contentId: entry.contentId,
              kind: "event" as const,
              title: entry.title,
            })),
        ];
      },
    }),
    loadGeneralTour(membership, { general: session.general }),
    session.content.portalHostname(membership.tenantId),
  ]);
  const visible = general.document.tours.some((tour) => tour.visible);

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <header className="admin-header">
        <Link href={`/o/${membership.slug}`} className="eyebrow">
          ← {membership.displayName}
        </Link>
        <SignOutButton />
      </header>
      <div className="branding-heading">
        <h1 className="title title-sm">Tours 360°</h1>
        <p className="lead">
          Recorridos virtuales de los destinos y eventos de {membership.displayName}: cada uno puede
          tener uno, armado con sus{" "}
          <Link href={`/o/${membership.slug}/panoramas`}>panoramas 360°</Link>. Al publicarse, cada
          tour tiene su página en el portal y todos forman el recorrido general.
        </p>
      </div>

      {canEdit ? (
        <section aria-labelledby="nuevo-tour" className="members-invite">
          <h2 id="nuevo-tour">Nuevo tour</h2>
          {candidates.length === 0 ? (
            <p className="field-hint">
              Todos los destinos y eventos próximos ya tienen su tour. Para uno nuevo, crea antes el
              destino o el evento.
            </p>
          ) : (
            <NewTourForm org={membership.slug} candidates={candidates} />
          )}
        </section>
      ) : (
        <p className="notice" role="status">
          Tu rol puede ver los tours, pero no crearlos ni cambiarlos.
        </p>
      )}

      {tours.length === 0 ? (
        <p className="notice">Todavía no hay tours.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="visually-hidden">Tours de {membership.displayName}</caption>
            <thead>
              <tr>
                <th scope="col">Tour de</th>
                <th scope="col">Estado</th>
                <th scope="col">Última modificación</th>
              </tr>
            </thead>
            <tbody>
              {tours.map((tour) => (
                <tr key={tour.tourId}>
                  <td>
                    <Link href={`/o/${membership.slug}/tours/${tour.tourId}`}>
                      {tour.contentTitle}
                    </Link>
                    <span className="cell-detail">
                      {KIND[tour.contentKind].label} · {scenesLabel(tour.scenes)}
                    </span>
                  </td>
                  <td>
                    <span className="status-pill" data-status={tour.status}>
                      {TOUR_STATUS[tour.status].label}
                    </span>
                    <span className="cell-detail">{TOUR_STATUS[tour.status].detail}</span>
                  </td>
                  <td>{DATE.format(new Date(tour.updatedAt))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section aria-labelledby="recorrido-general" className="members-invite">
        <h2 id="recorrido-general">Recorrido general</h2>
        <p className="field-hint">
          Los tours publicados forman un solo recorrido: el visitante salta de uno a otro sin salir
          del visor. Elige su orden y el tour con el que empieza. Se aplica al guardar.
        </p>
        {general.document.tours.length === 0 ? (
          <p className="notice">Cuando publiques un tour, aparecerá aquí.</p>
        ) : (
          <GeneralTourForm
            org={membership.slug}
            editCount={general.document.editCount}
            startTourId={general.document.startTourId}
            tours={general.document.tours}
            canEdit={general.canEdit}
          />
        )}
      </section>
      {visible && hostname ? (
        <PortalShare
          url={`${platformSettings().portalOrigin(hostname)}${PORTAL_PATHS.generalTour}`}
          slug="recorrido-general"
          title="Recorrido general"
          portalOnline={membership.tenantStatus === "active"}
          opens="el recorrido general"
        />
      ) : null}
    </main>
  );
}
