import {
  formatDateRange,
  formatShortDate,
  loadUnansweredQuestions,
  parseUnansweredPeriod,
  UNANSWERED_PERIOD_LABELS,
  UNANSWERED_PERIODS,
  type AssistantPageKind,
  type UnansweredGroup,
  type UnansweredPage,
} from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";

import { formatCount } from "@/components/statistics/format";
import { adminSession } from "@/server/admin-session";
import { requireModule } from "@/server/organization";

import { SignOutButton } from "../../../sign-out-button";
import "../estadisticas/statistics.css";
import "./questions.css";

export const metadata: Metadata = { title: "Lo que preguntan los visitantes" };

const PAGE_LABELS: Readonly<Record<AssistantPageKind, string>> = {
  home: "Inicio",
  destinations: "Lista de destinos",
  destination: "Ficha de un destino",
  destination_tour: "Tour 360° de un destino",
  agenda: "Agenda",
  event: "Ficha de un evento",
  event_tour: "Tour 360° de un evento",
  map: "Mapa",
  general_tour: "Recorrido general",
  other: "Otra página",
};

/** The first groups shown; the rest stay one click away. */
const SHOWN = 30;

function pageLabel(page: UnansweredPage): string {
  if (page.title === null) return PAGE_LABELS[page.pageKind];
  const where =
    page.pageKind === "destination_tour" || page.pageKind === "event_tour"
      ? `Tour 360° de «${page.title}»`
      : `Ficha de «${page.title}»`;
  return page.sceneTitle ? `${where}, escena «${page.sceneTitle}»` : where;
}

function times(count: number, one: string, many: string): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

interface QuestionProps {
  readonly group: UnansweredGroup;
  readonly org: string;
}

function Question({ group, org }: QuestionProps) {
  const editorOf = (page: UnansweredPage) =>
    page.contentId
      ? `/o/${org}/${page.kind === "event" ? "agenda" : "destinos"}/${page.contentId}`
      : null;
  return (
    <li className="question">
      <p className="question-text">
        <q>{group.text}</q>
        {group.langs.includes("en") ? (
          <span className="status-pill" data-status="draft">
            {group.langs.length === 1 ? "En inglés" : "También en inglés"}
          </span>
        ) : null}
      </p>
      <p className="field-hint">
        {times(group.times, "vez", "veces")} · {times(group.people, "persona", "personas")} · última
        vez el {formatShortDate(group.lastDay)}
      </p>
      {group.pages.length > 0 ? (
        <p className="question-pages">
          <span>Preguntada en:</span>{" "}
          {group.pages.map((page, index) => {
            const href = editorOf(page);
            const label = pageLabel(page);
            return (
              <span key={`${page.pageKind}|${page.contentId ?? ""}|${page.sceneTitle ?? ""}`}>
                {index > 0 ? ", " : null}
                {href ? <Link href={href}>{label}</Link> : label}
                {group.pages.length > 1 ? ` (${formatCount(page.times)})` : null}
              </span>
            );
          })}
        </p>
      ) : null}
      <p className="question-actions">
        <Link href={`/o/${org}/conocimiento?pregunta=${encodeURIComponent(group.text)}#probar`}>
          Probar esta pregunta en «Conocimiento del asistente»
        </Link>
      </p>
    </li>
  );
}

interface QuestionsPageProps {
  readonly params: Promise<{ slug: string }>;
  readonly searchParams: Promise<{ periodo?: string | string[] }>;
}

/** C1 · Paso 3 (ADR-053): what visitors ask and nothing published answers, for any member. */
export default async function QuestionsPage({ params, searchParams }: QuestionsPageProps) {
  const membership = await requireModule((await params).slug, "assistant");
  const period = parseUnansweredPeriod((await searchParams).periodo);
  const session = await adminSession();
  const data = await loadUnansweredQuestions(membership, session.questions, period);
  const base = `/o/${membership.slug}/preguntas`;
  const shown = data.groups.slice(0, SHOWN);
  const rest = data.groups.slice(SHOWN);

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <header className="admin-header">
        <Link href={`/o/${membership.slug}`} className="eyebrow">
          ← {membership.displayName}
        </Link>
        <SignOutButton />
      </header>
      <div className="branding-heading">
        <h1 className="title title-sm">Lo que preguntan los visitantes</h1>
        <p className="lead">
          Las preguntas que el asistente del portal no pudo responder porque no encontró nada
          publicado sobre eso. Si publicas la respuesta (en un destino, un evento o en{" "}
          <Link href={`/o/${membership.slug}/conocimiento`}>Conocimiento del asistente</Link>), la
          próxima vez responderá.
        </p>
      </div>

      <nav aria-label="Período" className="stats-periods">
        <ul>
          {UNANSWERED_PERIODS.map((option) => (
            <li key={option}>
              <Link
                href={option === "30-dias" ? base : `${base}?periodo=${option}`}
                aria-current={option === period ? "page" : undefined}
                className="stats-period"
              >
                {UNANSWERED_PERIOD_LABELS[option]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <p className="stats-range">
        <strong>{formatDateRange(data)}</strong>
        {data.since && data.since > data.from ? (
          <> · se guardan desde el {formatShortDate(data.since)}</>
        ) : null}
      </p>

      {data.since === null ? (
        <p className="notice" role="status">
          Todavía no hay preguntas sin respuesta. Aparecen aquí cuando un visitante pregunta algo
          que el asistente no encuentra en lo publicado.
        </p>
      ) : null}

      <section aria-labelledby="resumen" className="metrics-section">
        <h2 id="resumen">Resumen</h2>
        <ul className="stats-tiles">
          <li className="stats-tile">
            <span className="stats-tile-label">Preguntas sin respuesta</span>
            <span className="stats-tile-value">{formatCount(data.total)}</span>
          </li>
          <li className="stats-tile">
            <span className="stats-tile-label">Preguntas distintas</span>
            <span className="stats-tile-value">{formatCount(data.groups.length)}</span>
            <span className="field-hint">Las que dicen lo mismo cuentan como una.</span>
          </li>
          <li className="stats-tile">
            <span className="stats-tile-label">Personas</span>
            <span className="stats-tile-value">{formatCount(data.people)}</span>
            <span className="field-hint">Distintas cada día, sumadas.</span>
          </li>
        </ul>
      </section>

      <section aria-labelledby="preguntas" className="metrics-section">
        <h2 id="preguntas">Las más preguntadas</h2>
        {data.groups.length === 0 ? (
          <p className="field-hint">En este período no quedó ninguna pregunta sin respuesta.</p>
        ) : (
          <>
            <ol className="questions">
              {shown.map((group) => (
                <Question key={group.key} group={group} org={membership.slug} />
              ))}
            </ol>
            {rest.length > 0 ? (
              <details className="stats-details">
                <summary>Ver {formatCount(rest.length)} preguntas más</summary>
                <ol className="questions" start={SHOWN + 1}>
                  {rest.map((group) => (
                    <Question key={group.key} group={group} org={membership.slug} />
                  ))}
                </ol>
              </details>
            ) : null}
          </>
        )}
      </section>

      <section aria-labelledby="como-se-guardan" className="metrics-section">
        <h2 id="como-se-guardan">Cómo se guardan</h2>
        <ul className="metrics-list">
          <li>
            Solo las preguntas que el asistente no pudo responder con lo publicado. No se guardan
            las que respondió, los saludos, ni las que quedaron sin respuesta porque se acabó la
            cuota del día o falló el servicio de IA.
          </li>
          <li>
            No se guarda nada de quien pregunta. Los correos, teléfonos, números de documento y
            enlaces se reemplazan por [correo], [teléfono], [número] y [enlace] antes de guardar. Un
            nombre propio no se puede reconocer con seguridad y queda como lo escribió el visitante.
          </li>
          <li>
            Las preguntas que dicen lo mismo, sin contar mayúsculas, tildes ni signos, se juntan y
            se muestran con su redacción más reciente.
          </li>
          <li>Se borran solas a los 90 días.</li>
        </ul>
      </section>
    </main>
  );
}
