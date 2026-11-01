import { canEditContent, listKnowledge, loadKnowledgeOverview } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";

import { adminSession } from "@/server/admin-session";
import { requireOrganization } from "@/server/organization";

import { SignOutButton } from "../../../sign-out-button";
import { KnowledgeSearchForm, NewKnowledgeForm } from "./knowledge-forms";

export const metadata: Metadata = { title: "Conocimiento del asistente" };

const STATUS = {
  draft: { label: "Borrador", detail: "El asistente todavía no lo usa" },
  published: { label: "Publicado", detail: "El asistente lo usa" },
  changed: { label: "Publicado", detail: "Con cambios sin publicar" },
  retired: { label: "Retirado", detail: "El asistente ya no lo usa" },
} as const;

const KIND = {
  destination: "Destino",
  event: "Evento",
  knowledge: "Conocimiento",
} as const;

const DATE = new Intl.DateTimeFormat("es-BO", {
  dateStyle: "medium",
  timeStyle: "short",
  hour12: false,
  timeZone: "America/La_Paz",
});

const NUMBER = new Intl.NumberFormat("es-BO");

interface KnowledgePageProps {
  readonly params: Promise<{ slug: string }>;
}

export default async function KnowledgePage({ params }: KnowledgePageProps) {
  const membership = await requireOrganization((await params).slug);
  const session = await adminSession();
  const [items, overview] = await Promise.all([
    listKnowledge(membership, session.knowledge),
    loadKnowledgeOverview(membership, session.knowledge),
  ]);
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
        <h1 className="title title-sm">Conocimiento del asistente</h1>
        <p className="lead">
          Lo que el asistente del portal puede leer para responder a los visitantes: los destinos,
          eventos y tours 360° publicados, y los textos y documentos que agregues aquí (por ejemplo,
          un libro de historia en PDF). Los documentos no se muestran en el portal: el asistente los
          cita con su título y su página.
        </p>
      </div>

      <section aria-labelledby="probar" className="members-invite">
        <h2 id="probar">Probar la búsqueda</h2>
        <p className="field-hint">
          Escribe una pregunta como la haría un visitante y mira qué pasajes encontraría el
          asistente. Solo busca en lo publicado; no usa la IA ni gasta la cuota.
        </p>
        <KnowledgeSearchForm org={membership.slug} />
      </section>

      <section aria-labelledby="documentos" className="knowledge-section">
        <h2 id="documentos">Textos y documentos</h2>
        {canEdit ? (
          <div className="members-invite">
            <h3>Nuevo conocimiento</h3>
            <NewKnowledgeForm org={membership.slug} />
          </div>
        ) : (
          <p className="notice" role="status">
            Tu rol puede ver el conocimiento del asistente, pero no cambiarlo.
          </p>
        )}
        {items.length === 0 ? (
          <p className="notice">
            Todavía no agregaste textos ni documentos. El asistente ya puede usar lo que está
            publicado en el portal.
          </p>
        ) : (
          <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="documentos">
            <table className="data-table">
              <caption className="visually-hidden">
                Textos y documentos de {membership.displayName}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Nombre</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Última modificación</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.contentId}>
                    <td>
                      <Link href={`/o/${membership.slug}/conocimiento/${item.contentId}`}>
                        {item.title}
                      </Link>
                    </td>
                    <td>
                      <span
                        className="status-pill"
                        data-status={item.status === "retired" ? "draft" : item.status}
                      >
                        {STATUS[item.status].label}
                      </span>
                      <span className="cell-detail">{STATUS[item.status].detail}</span>
                    </td>
                    <td>{DATE.format(new Date(item.updatedAt))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="sabe" className="knowledge-section">
        <h2 id="sabe">Lo que el asistente ya leyó</h2>
        <p className="field-hint">
          Cada vez que se publica algo, el asistente lo lee en unos segundos.{" "}
          {overview.sources.length === 0
            ? "Todavía no hay nada publicado."
            : `${NUMBER.format(overview.indexed)} de ${NUMBER.format(overview.sources.length)} publicaciones leídas (${NUMBER.format(overview.chunks)} pasajes)${
                overview.pending > 0 ? `, ${NUMBER.format(overview.pending)} leyéndose` : ""
              }${overview.failed > 0 ? `, ${NUMBER.format(overview.failed)} con error` : ""}.`}
        </p>
        {overview.sources.length > 0 ? (
          <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="sabe">
            <table className="data-table">
              <caption className="visually-hidden">
                Publicaciones que lee el asistente de {membership.displayName}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Publicación</th>
                  <th scope="col">Tipo</th>
                  <th scope="col">Lectura</th>
                </tr>
              </thead>
              <tbody>
                {overview.sources.map((source) => (
                  <tr key={`${source.source}:${source.sourceId}`}>
                    <td>
                      {source.title}
                      <span className="cell-detail">Versión {source.revisionNo}</span>
                    </td>
                    <td>{source.source === "tour" ? "Tour 360°" : KIND[source.kind]}</td>
                    <td>
                      {source.chunks !== null ? (
                        <span>
                          Leído
                          <span className="cell-detail">
                            {source.chunks === 1
                              ? "1 pasaje"
                              : `${NUMBER.format(source.chunks)} pasajes`}
                          </span>
                        </span>
                      ) : source.job?.status === "dead_letter" ? (
                        <span className="field-error">
                          No se pudo leer. El equipo de la plataforma puede reintentarlo.
                        </span>
                      ) : (
                        <span>Leyéndose…</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </main>
  );
}
