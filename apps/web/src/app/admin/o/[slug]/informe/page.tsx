import {
  COPILOT_ISSUE_LABELS,
  formatDateRange,
  formatMonth,
  formatMonthTitle,
  formatShortDate,
  loadMonthlyReport,
  MONTHLY_REPORT_REQUESTS_PER_DAY,
  monthlyNoteLabel,
  type StatisticsTotal,
} from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";

import { Change } from "@/components/statistics/change";
import { DailyChart } from "@/components/statistics/daily-chart";
import { countryName, formatCount } from "@/components/statistics/format";
import { RecommendationList } from "@/components/statistics/recommendation-list";
import { adminSession } from "@/server/admin-session";
import { requireOrganization } from "@/server/organization";

import { SignOutButton } from "../../../sign-out-button";
import "../estadisticas/statistics.css";
import { PrintButton, SendReportForm } from "./report-actions";
import "./report.css";

export const metadata: Metadata = { title: "Informe mensual" };

const TOTALS: readonly { key: StatisticsTotal; label: string }[] = [
  { key: "views", label: "Vistas de páginas" },
  { key: "visitors", label: "Visitantes" },
  { key: "qr", label: "Escaneos de QR" },
  { key: "directions", label: "«Cómo llegar»" },
  { key: "share", label: "Compartir" },
  { key: "calendar", label: "Añadir al calendario" },
  { key: "scenes", label: "Escenas de tours vistas" },
];

const KIND_NAMES = { destination: "Destino", event: "Evento", knowledge: "Conocimiento" } as const;

/** «12 nov 2026, 19:40», in the municipality's time. */
function dateTime(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("es-BO", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timezone,
    }).format(new Date(iso));
  } catch {
    return formatShortDate(iso.slice(0, 10));
  }
}

interface ReportPageProps {
  readonly params: Promise<{ slug: string }>;
  readonly searchParams: Promise<{ mes?: string | string[] }>;
}

/**
 * C1 · Paso 5 (ADR-055): the month for the town hall, for any member, printable. The same
 * numbers as «Estadísticas», «Lo que preguntan los visitantes» and the content review.
 */
export default async function MonthlyReportPage({ params, searchParams }: ReportPageProps) {
  const membership = await requireOrganization((await params).slug);
  const session = await adminSession();
  const view = await loadMonthlyReport(
    membership,
    { reports: session.reports, statistics: session.statistics, copilot: session.copilot },
    (await searchParams).mes,
  );
  const { summary, status, questions, review, activity } = view;
  const saved = status.report;
  const timezone = view.snapshot.timezone;
  const names = new Map(view.snapshot.items.map((item) => [item.contentId, item.title] as const));
  const editorOf = (kind: string | null, contentId: string) =>
    `/o/${membership.slug}/${kind === "event" ? "agenda" : kind === "knowledge" ? "conocimiento" : "destinos"}/${contentId}`;
  const places = summary.places.filter((place) => place.views > 0).slice(0, 10);
  const tours = summary.tours.filter((tour) => tour.views + tour.sceneViews > 0).slice(0, 5);
  const before = view.current ? "los mismos días del mes anterior" : "el mes anterior";
  const missing = new Set(review.map((row) => row.contentId)).size;
  const fresh = activity.items.filter((item) => item.first && !item.tour);

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide report">
      <header className="admin-header report-screen-only">
        <Link href={`/o/${membership.slug}`} className="eyebrow">
          ← {membership.displayName}
        </Link>
        <SignOutButton />
      </header>

      <div className="branding-heading">
        <p className="eyebrow report-print-only">{membership.displayName}</p>
        <h1 className="title title-sm">
          Informe de {formatMonth(view.month)}
          {view.current ? " (hasta hoy)" : ""}
        </h1>
        <p className="lead">
          El portal de {membership.displayName} en el mes: visitas, lo más visto, lo que los
          visitantes preguntaron sin respuesta, el estado del contenido y las recomendaciones del
          Copilot.
        </p>
      </div>

      <div className="report-toolbar report-screen-only">
        <form method="get" className="report-month">
          <label htmlFor="mes">Mes</label>
          <select id="mes" name="mes" defaultValue={view.month}>
            {view.months.map((month) => (
              <option key={month} value={month}>
                {formatMonthTitle(month)}
                {month === view.months[0] ? " (en curso)" : ""}
              </option>
            ))}
          </select>
          <button type="submit" className="button button-quiet">
            Ver
          </button>
        </form>
        <PrintButton />
      </div>

      <p className="stats-range">
        <strong>{formatDateRange(summary.range)}</strong>
        {summary.compared ? (
          <> · comparado con {formatDateRange(summary.range.previous)}</>
        ) : view.firstDay ? (
          <> · sin comparación: las visitas se cuentan desde el {formatShortDate(view.firstDay)}</>
        ) : null}
      </p>

      <section aria-labelledby="visitas" className="metrics-section">
        <h2 id="visitas">Visitas</h2>
        {view.firstDay === null ? (
          <p className="field-hint">Todavía no hay visitas contadas en este portal.</p>
        ) : null}
        <ul className="stats-tiles">
          {TOTALS.map(({ key, label }) => (
            <li key={key} className="stats-tile">
              <span className="stats-tile-label">{label}</span>
              <span className="stats-tile-value">{formatCount(summary.totals[key].value)}</span>
              <Change measure={summary.totals[key]} />
            </li>
          ))}
        </ul>
        {summary.compared ? <p className="field-hint">Los cambios comparan con {before}.</p> : null}
        <DailyChart series={summary.series} />
        {summary.countries.length > 0 ? (
          <p className="field-hint">
            De dónde vienen:{" "}
            {summary.countries
              .slice(0, 5)
              .map((country) => `${countryName(country.country)} (${formatCount(country.views)})`)
              .join(", ")}
            .
          </p>
        ) : null}
      </section>

      <section aria-labelledby="mas-visto" className="metrics-section">
        <h2 id="mas-visto">Lo más visto</h2>
        {places.length === 0 ? (
          <p className="field-hint">Ninguna ficha se abrió en el mes.</p>
        ) : (
          <div className="table-wrap" role="region" aria-label="Lo más visto" tabIndex={0}>
            <table className="data-table metrics-table">
              <caption className="visually-hidden">
                Los destinos y eventos más vistos del mes
              </caption>
              <thead>
                <tr>
                  <th scope="col">Lugar</th>
                  <th scope="col">Vistas</th>
                  <th scope="col">QR</th>
                  <th scope="col">Cómo llegar</th>
                  <th scope="col">Compartir</th>
                </tr>
              </thead>
              <tbody>
                {places.map((place) => (
                  <tr key={place.contentId}>
                    <th scope="row">
                      <Link href={editorOf(place.kind, place.contentId)}>{place.title}</Link>
                      <span className="org-detail">
                        {place.kind === "event" ? "Evento" : "Destino"}
                      </span>
                    </th>
                    <td>{formatCount(place.views)}</td>
                    <td>{formatCount(place.qr)}</td>
                    <td>{formatCount(place.directions)}</td>
                    <td>{formatCount(place.share)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {tours.length > 0 ? (
          <>
            <h3 className="report-subtitle">Tours 360°</h3>
            <ul className="metrics-list">
              {tours.map((tour) => (
                <li key={tour.contentId}>
                  {tour.title}: {formatCount(tour.views)} {tour.views === 1 ? "vista" : "vistas"} y{" "}
                  {formatCount(tour.sceneViews)}{" "}
                  {tour.sceneViews === 1 ? "escena vista" : "escenas vistas"}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      <section aria-labelledby="preguntas" className="metrics-section">
        <h2 id="preguntas">Preguntas sin respuesta</h2>
        {questions.total === 0 ? (
          <p className="field-hint">El asistente respondió todas las preguntas del mes.</p>
        ) : (
          <>
            <p>
              El asistente no supo responder{" "}
              <strong>
                {formatCount(questions.total)} {questions.total === 1 ? "pregunta" : "preguntas"}
              </strong>{" "}
              de {formatCount(questions.people)} {questions.people === 1 ? "persona" : "personas"} (
              {formatCount(questions.groups.length)}{" "}
              {questions.groups.length === 1 ? "distinta" : "distintas"}). Las más frecuentes:
            </p>
            <ol className="metrics-list report-questions">
              {questions.groups.slice(0, 10).map((group) => (
                <li key={group.key}>
                  «{group.text}» · {formatCount(group.times)} {group.times === 1 ? "vez" : "veces"}
                  <Link
                    href={`/o/${membership.slug}/conocimiento?pregunta=${encodeURIComponent(group.text)}`}
                    className="report-screen-only report-inline-link"
                  >
                    Probar en «Conocimiento del asistente»
                  </Link>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>

      <section aria-labelledby="contenido-estado" className="metrics-section">
        <h2 id="contenido-estado">Estado del contenido</h2>
        <h3 className="report-subtitle">Publicado en el mes</h3>
        {activity.total === 0 ? (
          <p className="field-hint">No se publicó nada en el mes.</p>
        ) : (
          <>
            <p className="field-hint">
              {formatCount(fresh.length)}{" "}
              {fresh.length === 1 ? "contenido nuevo" : "contenidos nuevos"} y{" "}
              {formatCount(activity.total)} {activity.total === 1 ? "publicación" : "publicaciones"}{" "}
              en total.
            </p>
            <ul className="metrics-list">
              {activity.items.slice(0, 15).map((item) => (
                <li key={`${item.contentId}-${item.tour ? "tour" : "item"}`}>
                  {item.tour
                    ? `Tour 360° de ${item.title}`
                    : `${KIND_NAMES[item.kind]} ${item.title}`}
                  {item.first ? " (nuevo)" : ""}
                  {item.times > 1 ? ` · ${formatCount(item.times)} veces` : ""}
                </li>
              ))}
            </ul>
          </>
        )}
        <h3 className="report-subtitle">Lo que falta completar (hoy)</h3>
        {review.length === 0 ? (
          <p className="field-hint">
            A los destinos y eventos no les falta nada de lo que se revisa.
          </p>
        ) : (
          <>
            <p className="field-hint">
              {formatCount(missing)}{" "}
              {missing === 1 ? "destino o evento tiene" : "destinos o eventos tienen"} algo por
              completar.
            </p>
            <ul className="metrics-list">
              {review.slice(0, 12).map((row) => (
                <li key={`${row.contentId}-${row.sceneId ?? "item"}`}>
                  <Link href={editorOf(row.kind, row.contentId)}>{row.title}</Link>:{" "}
                  {row.sceneId
                    ? `la escena «${row.sceneTitle ?? ""}» no tiene descripción`
                    : row.issues
                        .map((issue) => COPILOT_ISSUE_LABELS[issue].toLowerCase())
                        .join("; ")}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section aria-labelledby="recomendaciones" className="metrics-section">
        <h2 id="recomendaciones">Recomendaciones del Copilot</h2>
        {saved && saved.items && saved.facts ? (
          <>
            <p className="recommendations-meta">
              Generadas el {dateTime(saved.generatedAt, timezone)} con las cifras{" "}
              {formatDateRange(saved)}. Cada una muestra las cifras en las que se basa; nada se
              publica solo.
            </p>
            <RecommendationList
              membership={membership}
              items={saved.items}
              facts={saved.facts}
              names={names}
            />
          </>
        ) : saved?.forgotten ? (
          <p className="field-hint">
            Las recomendaciones de este mes ya no se guardan: se borran a los 90 días, como las
            preguntas de los visitantes.
          </p>
        ) : saved ? (
          <p className="field-hint">{monthlyNoteLabel(saved.note)}</p>
        ) : view.current ? (
          <p className="field-hint">
            Las recomendaciones del mes se generan solas el día 1 del mes siguiente, con el mes
            completo.
          </p>
        ) : (
          <p className="field-hint">Este mes no tiene recomendaciones guardadas.</p>
        )}
      </section>

      <section aria-labelledby="correo" className="metrics-section report-screen-only">
        <h2 id="correo">Por correo</h2>
        <p className="field-hint">
          El día 1 de cada mes, propietarios y administradores reciben por correo el resumen del mes
          anterior con el enlace a esta página.
        </p>
        {saved?.mailedAt ? (
          <p>
            Se envió el {dateTime(saved.mailedAt, timezone)} a{" "}
            {saved.mailedCount === 1
              ? "1 persona"
              : `${formatCount(saved.mailedCount ?? 0)} personas`}
            .
          </p>
        ) : null}
        {status.pending ? (
          <p className="notice" role="status">
            Hay un informe de este mes en camino: llega en uno o dos minutos.
          </p>
        ) : null}
        {view.canSend ? (
          <>
            <SendReportForm
              org={membership.slug}
              month={view.month}
              disabled={status.pending || status.requestsToday >= MONTHLY_REPORT_REQUESTS_PER_DAY}
            />
            {status.requestsToday >= MONTHLY_REPORT_REQUESTS_PER_DAY ? (
              <p className="field-hint">Ya se pidió 3 veces hoy: se puede pedir otra vez mañana.</p>
            ) : null}
          </>
        ) : (
          <p className="field-hint">Solo propietarios y administradores pueden enviarlo.</p>
        )}
      </section>

      <section aria-labelledby="como-se-cuenta" className="metrics-section">
        <h2 id="como-se-cuenta">Cómo se cuenta</h2>
        <ul className="metrics-list">
          <li>
            Las visitas son un <strong>mínimo</strong>: no cuentan a quien bloquea JavaScript, a los
            buscadores ni a los robots. Un visitante es una persona distinta en un día.
          </li>
          <li>
            Las preguntas sin respuesta son las que el asistente no pudo responder con lo publicado;
            se guardan sin datos de quien preguntó y se borran a los 90 días.
          </li>
          <li>
            «Lo que falta completar» es la revisión del contenido de hoy, no la del fin de mes.
          </li>
          <li>Los días son los del municipio, en su hora.</li>
        </ul>
      </section>
    </main>
  );
}
