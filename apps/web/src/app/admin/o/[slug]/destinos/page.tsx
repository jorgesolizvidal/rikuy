import { canEditContent, listDestinations } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";

import { adminSession } from "@/server/admin-session";
import { requireOrganization } from "@/server/organization";

import { SignOutButton } from "../../../sign-out-button";
import { NewDestinationForm } from "./new-destination-form";

export const metadata: Metadata = { title: "Destinos" };

const STATUS = {
  draft: { label: "Borrador", detail: "Nunca publicado" },
  published: { label: "Publicado", detail: "Sin cambios pendientes" },
  changed: { label: "Publicado", detail: "Con cambios sin publicar" },
} as const;

const DATE = new Intl.DateTimeFormat("es-BO", {
  dateStyle: "medium",
  timeStyle: "short",
  hour12: false,
  timeZone: "America/La_Paz",
});

interface DestinationsPageProps {
  readonly params: Promise<{ slug: string }>;
}

export default async function DestinationsPage({ params }: DestinationsPageProps) {
  const membership = await requireOrganization((await params).slug);
  const destinations = await listDestinations(membership, (await adminSession()).content);
  const canEdit = canEditContent(membership.role);

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <header className="admin-header">
        <Link href={`/o/${membership.slug}`} className="eyebrow">
          ← {membership.displayName}
        </Link>
        <SignOutButton />
      </header>
      <div className="branding-heading">
        <h1 className="title title-sm">Destinos</h1>
        <p className="lead">
          Lugares para visitar en {membership.displayName}. Los visitantes solo ven la versión
          publicada de cada uno; los borradores son privados.
        </p>
      </div>

      {canEdit ? (
        <section aria-labelledby="nuevo-destino" className="members-invite">
          <h2 id="nuevo-destino">Nuevo destino</h2>
          <NewDestinationForm org={membership.slug} />
        </section>
      ) : (
        <p className="notice" role="status">
          Tu rol puede ver los destinos, pero no crearlos ni cambiarlos.
        </p>
      )}

      {destinations.length === 0 ? (
        <p className="notice">Todavía no hay destinos. Crea el primero con su nombre.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="visually-hidden">Destinos de {membership.displayName}</caption>
            <thead>
              <tr>
                <th scope="col">Destino</th>
                <th scope="col">Estado</th>
                <th scope="col">Última modificación</th>
              </tr>
            </thead>
            <tbody>
              {destinations.map((destination) => (
                <tr key={destination.contentId}>
                  <td>
                    <Link href={`/o/${membership.slug}/destinos/${destination.contentId}`}>
                      {destination.title}
                    </Link>
                    <span className="cell-detail">/{destination.slug}</span>
                  </td>
                  <td>
                    <span className="status-pill" data-status={destination.status}>
                      {STATUS[destination.status].label}
                    </span>
                    <span className="cell-detail">{STATUS[destination.status].detail}</span>
                  </td>
                  <td>{DATE.format(new Date(destination.updatedAt))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
