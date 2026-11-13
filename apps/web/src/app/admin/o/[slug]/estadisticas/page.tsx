import {
  formatDateRange,
  formatShortDate,
  loadRecommendations,
  loadStatistics,
  RECOMMENDATIONS_FRESH_DAYS,
  recommendationsAge,
  parseStatisticsPeriod,
  STATISTICS_PERIOD_LABELS,
  STATISTICS_PERIODS,
  type PortalPageTarget,
  type StatisticsTotal,
} from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";

import { DailyChart } from "@/components/statistics/daily-chart";
import { PassportSection } from "@/components/statistics/passport-section";
import { Change } from "@/components/statistics/change";
import { countryName, formatCount } from "@/components/statistics/format";
import { RecommendationList } from "@/components/statistics/recommendation-list";
import { adminSession } from "@/server/admin-session";
import { aiGatewayStatus } from "@/server/ai-gateway";
import { requireOrganization } from "@/server/organization";

import { SignOutButton } from "../../../sign-out-button";
import { RecommendationsForm } from "./recommendations-form";
import "./statistics.css";

export const metadata: Metadata = { title: "Estadísticas" };

const TOTAL_LABELS: Readonly<Record<StatisticsTotal, { label: string; hint: string }>> = {
  views: { label: "Vistas de páginas", hint: "Cada vez que alguien abre una página del portal." },
  visitors: {
    label: "Visitantes",
    hint: "Personas distintas cada día, sumadas: quien vuelve otro día cuenta otra vez.",
  },
  qr: { label: "Escaneos de QR", hint: "Llegadas desde los códigos QR del panel." },
  directions: { label: "«Cómo llegar»", hint: "Toques que abren la app de mapas." },
  share: { label: "Compartir", hint: "Toques en «Compartir» de una ficha." },
  calendar: { label: "Añadir al calendario", hint: "Eventos guardados en el calendario." },
  scenes: { label: "Escenas de tours vistas", hint: "Cada escena 360° que se mostró." },
};

const PAGE_LABELS: Readonly<Record<PortalPageTarget, string>> = {
  home: "Inicio",
  destinations: "Destinos (lista)",
  agenda: "Agenda",
  map: "Mapa",
  general_tour: "Recorrido general",
};

const SHOWN = 20;

/** «12 nov 2026, 19:40», in the municipality's time. */
function generatedAt(iso: string, timezone: string): string {
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

interface StatisticsPageProps {
  readonly params: Promise<{ slug: string }>;
  readonly searchParams: Promise<{ periodo?: string | string[] }>;
}

/** C1 · Paso 2 (ADR-052): what the municipality's portal is used for, for any member. */
export default async function StatisticsPage({ params, searchParams }: StatisticsPageProps) {
  const membership = await requireOrganization((await params).slug);
  const period = parseStatisticsPeriod((await searchParams).periodo);
  const session = await adminSession();
  const [{ summary, passport, firstDay }, saved, calendar] = await Promise.all([
    loadStatistics(membership, session.statistics, period),
    loadRecommendations(membership, session.recommendations),
    session.statistics.calendar(membership.tenantId),
  ]);
  // The names of the places and circuits the recommendations link to (their links say which).
  const names = new Map([
    ...(saved
      ? ((await session.copilot.snapshot(membership.tenantId).catch(() => null))?.items ?? []).map(
          (item) => [item.contentId, item.title] as const,
        )
      : []),
    ...(passport?.circuits ?? []).map((circuit) => [circuit.circuitId, circuit.name] as const),
  ]);
  const { range, totals } = summary;
  const base = `/o/${membership.slug}/estadisticas`;
  const editorOf = (kind: string | null, contentId: string) =>
    `/o/${membership.slug}/${kind === "event" ? "agenda" : "destinos"}/${contentId}`;
  const download = (kind: string) => `${base}/descargar?periodo=${period}&tipo=${kind}`;

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <header className="admin-header">
        <Link href={`/o/${membership.slug}`} className="eyebrow">
          ← {membership.displayName}
        </Link>
        <SignOutButton />
      </header>
      <div className="branding-heading">
        <h1 className="title title-sm">Estadísticas</h1>
        <p className="lead">
          Qué miran y qué hacen los visitantes en el portal de {membership.displayName}. Se cuenta
          sin cookies y sin guardar nada que identifique a una persona.
        </p>
      </div>

      <nav aria-label="Período" className="stats-periods">
        <ul>
          {STATISTICS_PERIODS.map((option) => (
            <li key={option}>
              <Link
                href={option === "30-dias" ? base : `${base}?periodo=${option}`}
                aria-current={option === period ? "page" : undefined}
                className="stats-period"
              >
                {STATISTICS_PERIOD_LABELS[option]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <p className="stats-range">
        <strong>{formatDateRange(range)}</strong>
        {summary.compared ? (
          <> · comparado con {formatDateRange(range.previous)}</>
        ) : firstDay ? (
          <> · sin comparación: las visitas se cuentan desde el {formatShortDate(firstDay)}</>
        ) : null}
      </p>

      {firstDay === null ? (
        <p className="notice" role="status">
          Todavía no hay visitas contadas. Los números aparecen aquí apenas alguien abre el portal.
        </p>
      ) : null}

      <section aria-labelledby="resumen" className="metrics-section">
        <h2 id="resumen">Resumen</h2>
        <ul className="stats-tiles">
          {(Object.keys(TOTAL_LABELS) as StatisticsTotal[]).map((key) => (
            <li key={key} className="stats-tile">
              <span className="stats-tile-label">{TOTAL_LABELS[key].label}</span>
              <span className="stats-tile-value">{formatCount(totals[key].value)}</span>
              <Change measure={totals[key]} />
              <span className="field-hint">{TOTAL_LABELS[key].hint}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="por-dia" className="metrics-section">
        <h2 id="por-dia">Vistas por día</h2>
        <DailyChart series={summary.series} />
        <details className="stats-details">
          <summary>Ver los números de cada día</summary>
          <div
            className="table-wrap"
            role="region"
            aria-label="Vistas y visitantes por día"
            tabIndex={0}
          >
            <table className="data-table metrics-table">
              <caption className="visually-hidden">Vistas y visitantes por día</caption>
              <thead>
                <tr>
                  <th scope="col">Día</th>
                  <th scope="col">Vistas</th>
                  <th scope="col">Visitantes</th>
                </tr>
              </thead>
              <tbody>
                {summary.series.map((day) => (
                  <tr key={day.day}>
                    <th scope="row">{formatShortDate(day.day)}</th>
                    <td>{formatCount(day.views)}</td>
                    <td>{formatCount(day.visitors)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <section aria-labelledby="lugares" className="metrics-section">
        <h2 id="lugares">Lo más visto: destinos y eventos</h2>
        {summary.places.length === 0 ? (
          <p className="field-hint">Ninguna ficha se abrió en este período.</p>
        ) : (
          <div className="table-wrap" role="region" aria-label="Destinos y eventos" tabIndex={0}>
            <table className="data-table metrics-table">
              <caption className="visually-hidden">
                Vistas y acciones de cada destino y evento
              </caption>
              <thead>
                <tr>
                  <th scope="col">Lugar</th>
                  <th scope="col">Vistas</th>
                  <th scope="col">Visitantes</th>
                  <th scope="col">QR</th>
                  <th scope="col">Cómo llegar</th>
                  <th scope="col">Compartir</th>
                  <th scope="col">Calendario</th>
                </tr>
              </thead>
              <tbody>
                {summary.places.slice(0, SHOWN).map((place) => (
                  <tr key={place.contentId}>
                    <th scope="row">
                      <Link href={editorOf(place.kind, place.contentId)}>{place.title}</Link>
                      <span className="org-detail">
                        {place.kind === "event" ? "Evento" : "Destino"}
                      </span>
                    </th>
                    <td>{formatCount(place.views)}</td>
                    <td>{formatCount(place.visitors)}</td>
                    <td>{formatCount(place.qr)}</td>
                    <td>{formatCount(place.directions)}</td>
                    <td>{formatCount(place.share)}</td>
                    <td>{place.kind === "event" ? formatCount(place.calendar) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {summary.places.length > SHOWN ? (
          <p className="field-hint">
            Y {summary.places.length - SHOWN} más: están todos en la descarga.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="tours" className="metrics-section">
        <h2 id="tours">Tours 360°</h2>
        {summary.tours.length === 0 ? (
          <p className="field-hint">Ningún tour se abrió en este período.</p>
        ) : (
          <ul className="stats-tours">
            {summary.tours.map((tour) => (
              <li key={tour.contentId} className="stats-tour">
                <h3>
                  <Link href={editorOf(tour.kind, tour.contentId)}>{tour.title}</Link>
                </h3>
                <p className="field-hint">
                  {formatCount(tour.views)} {tour.views === 1 ? "vista" : "vistas"} del tour ·{" "}
                  {formatCount(tour.visitors)} visitantes · {formatCount(tour.sceneViews)}{" "}
                  {tour.sceneViews === 1 ? "escena vista" : "escenas vistas"}
                  {tour.qr > 0 ? ` · ${formatCount(tour.qr)} por QR` : ""}
                </p>
                {tour.scenes.length > 0 ? (
                  <details className="stats-details">
                    <summary>Escenas ({tour.scenes.length})</summary>
                    <ol className="metrics-list">
                      {tour.scenes.map((scene) => (
                        <li key={scene.sceneId}>
                          {scene.title ?? "Escena de un tour borrado"}: {formatCount(scene.views)}{" "}
                          {scene.views === 1 ? "vez" : "veces"}
                        </li>
                      ))}
                    </ol>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {passport?.active ? (
        <PassportSection
          org={membership.slug}
          passport={passport}
          headingId="pasaporte"
          period="en este período"
        />
      ) : null}

      <section aria-labelledby="paginas" className="metrics-section">
        <h2 id="paginas">Páginas del portal</h2>
        <div className="table-wrap" role="region" aria-label="Páginas del portal" tabIndex={0}>
          <table className="data-table metrics-table">
            <caption className="visually-hidden">
              Vistas de las páginas generales del portal
            </caption>
            <thead>
              <tr>
                <th scope="col">Página</th>
                <th scope="col">Vistas</th>
                <th scope="col">Visitantes</th>
              </tr>
            </thead>
            <tbody>
              {summary.pages.map((page) => (
                <tr key={page.target}>
                  <th scope="row">
                    {PAGE_LABELS[page.target]}
                    {page.qr > 0 ? (
                      <span className="org-detail">{formatCount(page.qr)} por QR</span>
                    ) : null}
                  </th>
                  <td>{formatCount(page.views)}</td>
                  <td>{formatCount(page.visitors)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="origen" className="metrics-section">
        <h2 id="origen">De dónde vienen</h2>
        <p className="field-hint">
          País y ciudad aproximados, según la conexión (no la ubicación del teléfono). Una red móvil
          puede figurar en la ciudad de su operador.
        </p>
        {summary.countries.length === 0 ? (
          <p className="field-hint">Sin datos de origen en este período.</p>
        ) : (
          <div className="stats-origins">
            <div className="table-wrap" role="region" aria-label="Países" tabIndex={0}>
              <table className="data-table metrics-table">
                <caption className="visually-hidden">Vistas por país</caption>
                <thead>
                  <tr>
                    <th scope="col">País</th>
                    <th scope="col">Vistas</th>
                    <th scope="col">Visitantes</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.countries.slice(0, 10).map((country) => (
                    <tr key={country.country ?? "-"}>
                      <th scope="row">{countryName(country.country)}</th>
                      <td>{formatCount(country.views)}</td>
                      <td>{formatCount(country.visitors)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-wrap" role="region" aria-label="Ciudades" tabIndex={0}>
              <table className="data-table metrics-table">
                <caption className="visually-hidden">Vistas por ciudad</caption>
                <thead>
                  <tr>
                    <th scope="col">Ciudad</th>
                    <th scope="col">Vistas</th>
                    <th scope="col">Visitantes</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.cities.slice(0, 10).map((city) => (
                    <tr key={`${city.country ?? "-"}|${city.city ?? "-"}`}>
                      <th scope="row">
                        {city.city ?? "Sin identificar"}
                        {city.country !== null ? (
                          <span className="org-detail">{countryName(city.country)}</span>
                        ) : null}
                      </th>
                      <td>{formatCount(city.views)}</td>
                      <td>{formatCount(city.visitors)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <section aria-labelledby="descargar" className="metrics-section">
        <h2 id="descargar">Descargar</h2>
        <p className="field-hint">
          Los totales de cada día del período, para abrir en Excel o adjuntar a un informe.
        </p>
        <ul className="stats-downloads">
          <li>
            <a href={download("visitas")} download>
              Visitas por día, página y lugar (CSV)
            </a>
          </li>
          <li>
            <a href={download("origen")} download>
              Origen por día (CSV)
            </a>
          </li>
          {passport?.active ? (
            <li>
              <a href={download("pasaporte")} download>
                Pasaporte turístico por día: sellos y circuitos (CSV)
              </a>
            </li>
          ) : null}
        </ul>
      </section>

      <section aria-labelledby="recomendaciones" className="metrics-section">
        <h2 id="recomendaciones">Recomendaciones del Copilot</h2>
        <p className="field-hint">
          Con las visitas de los últimos 30 días, el pasaporte turístico, las preguntas que el
          asistente no supo responder, la revisión del contenido y la agenda. Cada recomendación
          muestra las cifras en las que se basa. Nada se publica ni cambia solo: los enlaces llevan
          a donde lo hace una persona del equipo.
        </p>
        {saved ? (
          <>
            <p className="recommendations-meta">
              Generadas el {generatedAt(saved.createdAt, calendar.timezone)} · visitas{" "}
              {formatDateRange(saved)}
            </p>
            {recommendationsAge(saved) >= RECOMMENDATIONS_FRESH_DAYS ? (
              <p className="notice" role="status">
                Estas recomendaciones tienen más de {RECOMMENDATIONS_FRESH_DAYS} días: genera unas
                nuevas para ver las cifras de ahora.
              </p>
            ) : null}
            <RecommendationList
              membership={membership}
              items={saved.items}
              facts={saved.facts}
              names={names}
            />
          </>
        ) : (
          <p className="field-hint">Todavía no hay recomendaciones para este municipio.</p>
        )}
        <RecommendationsForm
          org={membership.slug}
          enabled={aiGatewayStatus().configured}
          hasSaved={saved !== null}
        />
      </section>

      <p className="field-hint">
        Para la alcaldía: el <Link href={`/o/${membership.slug}/informe`}>informe mensual</Link>,
        para imprimir o guardar como PDF, con las recomendaciones del mes.
      </p>

      <section aria-labelledby="como-se-cuenta" className="metrics-section">
        <h2 id="como-se-cuenta">Cómo se cuenta</h2>
        <ul className="metrics-list">
          <li>
            Los números son un <strong>mínimo</strong>: no cuentan a quien bloquea JavaScript, a los
            buscadores ni a los robots.
          </li>
          <li>
            Un visitante es una persona distinta en un día: quien vuelve al día siguiente cuenta
            otra vez, y una familia en la misma red y con el mismo navegador cuenta una vez.
          </li>
          <li>
            Los escaneos de QR cuentan con los códigos que se descargan del panel desde que se
            cuentan las visitas; uno impreso antes funciona igual, pero no se cuenta.
          </li>
          <li>
            Pasaporte turístico: un teléfono cuenta una vez por lugar y día, con una huella que
            cambia cada día y se borra a los dos días. «Comprobadas en el lugar» son los sellos con
            la ubicación del teléfono dentro del lugar; un sello sin ubicación vale igual para el
            circuito.
          </li>
          <li>Los días son los del municipio, en su hora.</li>
        </ul>
      </section>
    </main>
  );
}
