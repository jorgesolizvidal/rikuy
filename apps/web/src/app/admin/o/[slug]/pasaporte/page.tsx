import { canRenewStampCodes, loadPassport, loadStampCodes } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";

import { adminSession } from "@/server/admin-session";
import { requireModule } from "@/server/organization";
import { platformSettings } from "@/server/platform";

import { SignOutButton } from "../../../sign-out-button";
import { NewCircuitForm } from "./new-circuit-form";
import { StampCodes } from "./stamp-codes";
import "./passport.css";

export const metadata: Metadata = { title: "Pasaporte turístico" };

const DATE = new Intl.DateTimeFormat("es-BO", {
  dateStyle: "medium",
  timeStyle: "short",
  hour12: false,
  timeZone: "America/La_Paz",
});

interface PassportPageProps {
  readonly params: Promise<{ slug: string }>;
}

/** C2 · Paso 1 (ADR-056): the circuits of the tourist passport. Any member sees them. */
export default async function PassportAdminPage({ params }: PassportPageProps) {
  const membership = await requireModule((await params).slug, "passport");
  const session = await adminSession();
  const [{ circuits, canEdit }, codes, hostname] = await Promise.all([
    loadPassport(membership, { passport: session.passport, content: session.content }),
    loadStampCodes(membership, session.stampCodes),
    session.content.portalHostname(membership.tenantId),
  ]);

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <header className="admin-header">
        <Link href={`/o/${membership.slug}`} className="eyebrow">
          ← {membership.displayName}
        </Link>
        <SignOutButton />
      </header>
      <div className="branding-heading">
        <h1 className="title title-sm">Pasaporte turístico</h1>
        <p className="lead">
          Circuitos de destinos de {membership.displayName}: el visitante los recorre en el orden
          que prefiera y, al completarlos, recibe el premio que definas. Cada circuito publicado
          tiene su página en el portal.
        </p>
      </div>

      {canEdit ? (
        <section aria-labelledby="nuevo-circuito" className="members-invite">
          <h2 id="nuevo-circuito">Nuevo circuito</h2>
          <NewCircuitForm org={membership.slug} />
        </section>
      ) : (
        <p className="notice" role="status">
          Tu rol puede ver los circuitos, pero no crearlos ni cambiarlos.
        </p>
      )}

      {circuits.length === 0 ? (
        <p className="notice">Todavía no hay circuitos.</p>
      ) : (
        <div className="table-wrap" role="region" aria-label="Circuitos" tabIndex={0}>
          <table className="data-table">
            <caption className="visually-hidden">Circuitos de {membership.displayName}</caption>
            <thead>
              <tr>
                <th scope="col">Circuito</th>
                <th scope="col">Estado</th>
                <th scope="col">Última modificación</th>
              </tr>
            </thead>
            <tbody>
              {circuits.map((circuit) => {
                const published = circuit.stops.filter((stop) => stop.published).length;
                return (
                  <tr key={circuit.id}>
                    <td>
                      <Link href={`/o/${membership.slug}/pasaporte/${circuit.id}`}>
                        {circuit.name}
                      </Link>
                      <span className="cell-detail">
                        {circuit.stops.length === 1
                          ? "1 parada"
                          : `${circuit.stops.length} paradas`}
                        {published < circuit.stops.length
                          ? ` · ${published} con destino publicado`
                          : ""}
                      </span>
                    </td>
                    <td>
                      <span className="status-pill" data-status={circuit.status}>
                        {circuit.status === "published" ? "Publicado" : "Borrador"}
                      </span>
                      {circuit.status === "draft" && circuit.publishedAt ? (
                        <span className="cell-detail">Retirado del portal</span>
                      ) : null}
                    </td>
                    <td>{DATE.format(new Date(circuit.updatedAt))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {codes === null ? null : (
        <StampCodes
          org={membership.slug}
          codes={codes}
          portalOrigin={hostname ? platformSettings().portalOrigin(hostname) : null}
          portalOnline={membership.tenantStatus === "active"}
          canRenew={canRenewStampCodes(membership.role)}
        />
      )}
    </main>
  );
}
