import {
  canPropose,
  COPILOT_ISSUE_LABELS,
  COPILOT_PATHS,
  loadCopilot,
  PROPOSAL_FIELD_LABELS,
  proposableFields,
  type CopilotReviewRow,
  type ProposalListEntry,
} from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";

import { adminSession } from "@/server/admin-session";
import { aiGatewayStatus } from "@/server/ai-gateway";
import { requireModule } from "@/server/organization";

import { SignOutButton } from "../../../sign-out-button";
import { CopilotChat } from "./copilot-chat";

export const metadata: Metadata = { title: "Copilot" };

const KIND = { destination: "Destino", event: "Evento" } as const;
const STATE = { draft: "Borrador", published: "Publicado", changed: "Con cambios" } as const;

const PROPOSAL_STATUS: Record<ProposalListEntry["status"], string> = {
  pending: "Pendiente",
  accepted: "Aceptada",
  rejected: "Rechazada",
  expired: "Vencida",
};

const DATE = new Intl.DateTimeFormat("es-BO", {
  dateStyle: "medium",
  timeStyle: "short",
  hour12: false,
  timeZone: "America/La_Paz",
});

function editorHref(org: string, row: CopilotReviewRow): string {
  return row.tourId
    ? COPILOT_PATHS.tour(org, row.tourId)
    : COPILOT_PATHS.editor(org, row.kind, row.contentId);
}

function proposeHref(org: string, row: CopilotReviewRow): string {
  const target =
    row.tourId && row.sceneId
      ? ({ type: "scene", tourId: row.tourId, sceneId: row.sceneId } as const)
      : ({ type: "content", contentId: row.contentId } as const);
  const fields = proposableFields(row);
  return `${COPILOT_PATHS.propose(org, target)}${fields.length > 0 ? `&campos=${fields.join(",")}` : ""}`;
}

interface CopilotPageProps {
  readonly params: Promise<{ slug: string }>;
}

export default async function CopilotPage({ params }: CopilotPageProps) {
  const membership = await requireModule((await params).slug, "copilot");
  const session = await adminSession();
  const { review, proposals } = await loadCopilot(membership, session.copilot);
  const enabled = aiGatewayStatus().configured;
  const editing = canPropose(membership);
  const org = membership.slug;
  const pending = proposals?.filter((proposal) => proposal.status === "pending") ?? [];
  const decided = proposals?.filter((proposal) => proposal.status !== "pending") ?? [];

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <header className="admin-header">
        <Link href={`/o/${org}`} className="eyebrow">
          ← {membership.displayName}
        </Link>
        <SignOutButton />
      </header>
      <div className="branding-heading">
        <h1 className="title title-sm">Copilot</h1>
        <p className="lead">
          Te ayuda a revisar y mejorar el contenido del municipio. Lee los destinos, eventos y tours
          (también los borradores) y propone textos que tú revisas antes de guardarlos. Nunca
          publica ni cambia nada por su cuenta: lo aceptado queda como borrador, y publicar sigue
          siendo tu decisión.
        </p>
        <p className="field-hint">
          Las recomendaciones a partir de las visitas y de lo que preguntan los visitantes están en{" "}
          <Link href={`/o/${org}/estadisticas#recomendaciones`}>
            «Estadísticas» → Recomendaciones del Copilot
          </Link>
          .
        </p>
      </div>

      <section aria-labelledby="preguntar" className="members-invite">
        <h2 id="preguntar">Preguntar</h2>
        <CopilotChat org={org} enabled={enabled} />
      </section>

      <section aria-labelledby="revision" className="knowledge-section">
        <h2 id="revision">Revisión del contenido</h2>
        <p className="field-hint">
          Lo que le falta a cada destino, evento y escena, calculado con reglas fijas (no con la
          IA): siempre funciona y no gasta la cuota.
          {editing ? " «Proponer» pide al Copilot un texto para revisar." : null}
        </p>
        {review.length === 0 ? (
          <p className="notice" role="status">
            No hay nada pendiente: todos los destinos, eventos y escenas tienen lo básico.
          </p>
        ) : (
          <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="revision">
            <table className="data-table">
              <caption className="visually-hidden">
                Revisión del contenido de {membership.displayName}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Contenido</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Qué le falta</th>
                  <th scope="col">
                    <span className="visually-hidden">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {review.map((row) => {
                  const name = row.sceneTitle
                    ? `${row.title} · escena «${row.sceneTitle}»`
                    : row.title;
                  return (
                    <tr key={`${row.contentId}-${row.sceneId ?? ""}`}>
                      <td>
                        <Link href={editorHref(org, row)}>{name}</Link>
                        <span className="cell-detail">
                          {row.sceneId ? "Tour 360°" : KIND[row.kind]}
                        </span>
                      </td>
                      <td>
                        <span
                          className="status-pill"
                          data-status={row.status === "changed" ? "published" : row.status}
                        >
                          {STATE[row.status]}
                        </span>
                      </td>
                      <td>
                        <ul className="copilot-issues">
                          {row.issues.map((issue) => (
                            <li key={issue}>{COPILOT_ISSUE_LABELS[issue]}</li>
                          ))}
                        </ul>
                      </td>
                      <td className="cell-actions">
                        {editing && enabled && proposableFields(row).length > 0 ? (
                          <Link
                            href={proposeHref(org, row)}
                            className="button button-small"
                            aria-label={`Proponer textos para ${name}`}
                          >
                            Proponer
                          </Link>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {proposals !== null ? (
        <section aria-labelledby="propuestas" className="knowledge-section">
          <h2 id="propuestas">Propuestas</h2>
          <p className="field-hint">
            Cada propuesta espera 30 días. Al aceptarla eliges qué campos guardar como borrador; si
            alguien cambió el contenido mientras tanto, queda desactualizada y hay que pedir otra.
          </p>
          {proposals.length === 0 ? (
            <p className="notice">
              Todavía no hay propuestas. Pídelas desde «Proponer» en la revisión o con «Proponer con
              el Copilot» en el editor de un destino, un evento o una escena.
            </p>
          ) : (
            <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="propuestas">
              <table className="data-table">
                <caption className="visually-hidden">Propuestas del Copilot</caption>
                <thead>
                  <tr>
                    <th scope="col">Para</th>
                    <th scope="col">Campos</th>
                    <th scope="col">Estado</th>
                    <th scope="col">Pedida</th>
                  </tr>
                </thead>
                <tbody>
                  {[...pending, ...decided].map((proposal) => (
                    <tr key={proposal.id}>
                      <td>
                        <Link href={COPILOT_PATHS.proposal(org, proposal.id)}>
                          {proposal.sceneTitle
                            ? `${proposal.title} · escena «${proposal.sceneTitle}»`
                            : proposal.title}
                        </Link>
                      </td>
                      <td>
                        {proposal.fields.map((field) => PROPOSAL_FIELD_LABELS[field]).join(", ")}
                      </td>
                      <td>
                        <span
                          className="status-pill"
                          data-status={
                            proposal.status === "pending" && !proposal.stale ? "published" : "draft"
                          }
                        >
                          {proposal.status === "pending" && proposal.stale
                            ? "Desactualizada"
                            : PROPOSAL_STATUS[proposal.status]}
                        </span>
                      </td>
                      <td>
                        {DATE.format(new Date(proposal.createdAt))}
                        {proposal.mine ? <span className="cell-detail">Por ti</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : (
        <p className="notice" role="status">
          Tu rol puede preguntar y ver la revisión, pero no pedir propuestas ni guardarlas.
        </p>
      )}
    </main>
  );
}
