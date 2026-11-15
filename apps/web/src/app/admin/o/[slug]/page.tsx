import { canEditContent, hasModule, loadPanelOverview, type PanelContentCounts } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";

import { Change } from "@/components/statistics/change";
import { formatCount } from "@/components/statistics/format";
import { adminSession } from "@/server/admin-session";
import { requireOrganization } from "@/server/organization";
import { platformSettings } from "@/server/platform";

import "./estadisticas/statistics.css";

interface OrganizationPageProps {
  readonly params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: OrganizationPageProps): Promise<Metadata> {
  return { title: (await requireOrganization((await params).slug)).displayName };
}

const plural = (count: number, one: string, many: string) =>
  `${formatCount(count)} ${count === 1 ? one : many}`;

function contentLine(counts: PanelContentCounts, one: string, many: string): string {
  const parts = [plural(counts.published, `${one} publicado`, `${many} publicados`)];
  if (counts.changed > 0) parts.push(`${formatCount(counts.changed)} con cambios sin publicar`);
  if (counts.drafts > 0) parts.push(plural(counts.drafts, "borrador", "borradores"));
  return parts.join(" · ");
}

/**
 * The municipality's home in the panel (C3 · Paso 7, ADR-066): a summary with real numbers
 * (the portal, the last 7 days, what visitors asked without an answer, what the Copilot's
 * review says is missing, the content); the menu has every section.
 */
export default async function OrganizationPage({ params }: OrganizationPageProps) {
  const membership = await requireOrganization((await params).slug);
  const session = await adminSession();
  const overview = await loadPanelOverview(membership, {
    statistics: session.statistics,
    questions: session.questions,
    copilot: session.copilot,
    content: session.content,
  });
  const base = `/o/${membership.slug}`;
  const canEdit = canEditContent(membership.role);
  const { portal, visits, questions, review, content } = overview;

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide panel-home">
      <div className="branding-heading">
        <h1 className="title title-sm">{membership.displayName}</h1>
        {/* What people come here to do (C3 · Paso 8): one tap away, by role and module. */}
        <ul className="panel-quick" aria-label="Acciones rápidas">
          {canEdit ? (
            <li>
              <Link prefetch={false} className="button" href={`${base}/destinos?nuevo`}>
                Nuevo destino
              </Link>
            </li>
          ) : null}
          {canEdit && hasModule(membership.modules, "agenda") ? (
            <li>
              <Link prefetch={false} className="button button-quiet" href={`${base}/agenda?nuevo`}>
                Nuevo evento
              </Link>
            </li>
          ) : null}
          {portal.hostname ? (
            <li>
              <a
                className="button button-quiet"
                href={platformSettings().portalOrigin(portal.hostname)}
                target="_blank"
                rel="noopener"
              >
                Ver el portal<span className="visually-hidden"> (se abre en otra pestaña)</span>
              </a>
            </li>
          ) : null}
        </ul>
      </div>

      <section aria-labelledby="resumen" className="panel-summary">
        <h2 id="resumen">Resumen</h2>
        <ul className="summary-grid">
          <li className="summary-tile">
            <p className="summary-label">Portal</p>
            <p className="summary-value">
              <span className="status-pill" data-status={portal.online ? "active" : "pending"}>
                {portal.online ? "En línea" : "En preparación"}
              </span>
            </p>
            <p className="summary-detail">
              {portal.online
                ? "Los visitantes lo ven en su dirección."
                : "Todavía no está en línea: lo pone en línea el operador de la plataforma."}
            </p>
            {portal.hostname ? (
              <a
                className="summary-link"
                href={platformSettings().portalOrigin(portal.hostname)}
                target="_blank"
                rel="noopener"
              >
                {portal.hostname}
                <span className="visually-hidden"> (se abre en otra pestaña)</span>
              </a>
            ) : null}
          </li>

          {visits ? (
            <li className="summary-tile">
              <p className="summary-label">Visitas · últimos 7 días</p>
              <p className="summary-value">
                <span className="summary-number">{formatCount(visits.views.value)}</span>{" "}
                <Change measure={visits.views} />
              </p>
              <p className="summary-detail">
                {visits.counting
                  ? "Todavía no se contó ninguna visita."
                  : `${plural(visits.visitors, "visitante", "visitantes")} (sumados por día)`}
              </p>
              <Link
                prefetch={false}
                className="summary-link"
                href={`${base}/estadisticas?periodo=7-dias`}
              >
                Ver las estadísticas
              </Link>
            </li>
          ) : null}

          {questions ? (
            <li className="summary-tile">
              <p className="summary-label">Preguntas sin respuesta · últimos 7 días</p>
              <p className="summary-value">
                <span className="summary-number">{formatCount(questions.total)}</span>
              </p>
              <p className="summary-detail">
                {questions.total === 0
                  ? "El asistente encontró respuesta para todo lo que le preguntaron."
                  : `${plural(questions.distinct, "pregunta distinta", "preguntas distintas")}: publica la respuesta y el asistente la usará.`}
              </p>
              <Link
                prefetch={false}
                className="summary-link"
                href={`${base}/preguntas?periodo=7-dias`}
              >
                Ver qué preguntaron
              </Link>
            </li>
          ) : null}

          {review ? (
            <li className="summary-tile">
              <p className="summary-label">Revisión del Copilot</p>
              <p className="summary-value">
                <span className="summary-number">{formatCount(review.contents)}</span>
              </p>
              <p className="summary-detail">
                {review.contents === 0 && review.scenes === 0
                  ? "Nada pendiente: el contenido tiene lo que la revisión pide."
                  : `${review.contents === 1 ? "contenido con algo por completar" : "contenidos con algo por completar"}${
                      review.scenes > 0
                        ? ` y ${plural(review.scenes, "escena sin descripción", "escenas sin descripción")}`
                        : ""
                    }.`}
              </p>
              <Link prefetch={false} className="summary-link" href={`${base}/copilot`}>
                Ver la revisión
              </Link>
            </li>
          ) : null}

          {content ? (
            <li className="summary-tile">
              <p className="summary-label">Contenido</p>
              <p className="summary-detail">
                <strong>Destinos:</strong>{" "}
                {contentLine(content.destinations, "destino", "destinos")}
              </p>
              {content.events ? (
                <p className="summary-detail">
                  <strong>Eventos:</strong> {contentLine(content.events, "evento", "eventos")}
                </p>
              ) : null}
              <Link prefetch={false} className="summary-link" href={`${base}/destinos`}>
                Ir a la lista de destinos
              </Link>
            </li>
          ) : null}
        </ul>
        {visits === null || content === null ? (
          <p className="field-hint">
            Una parte del resumen no se pudo leer ahora; recarga la página.
          </p>
        ) : null}
      </section>

      {membership.demo ? (
        <p className="notice">
          Es una demo comercial: su portal no aparece en buscadores y avisa a los visitantes que es
          una demostración.
        </p>
      ) : null}
    </main>
  );
}
