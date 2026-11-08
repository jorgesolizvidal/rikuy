import { loadTenantMetrics, MEASURED_ROUTES, type MeasuredRoute } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { operatorContext } from "@/server/operator";

import { SignOutButton } from "../../../sign-out-button";
import { CheckPublicationButton } from "../check-button";
import { ErrorsTable } from "../errors-table";
import {
  countOf,
  formatBucket,
  formatBytes,
  formatCount,
  formatMs,
  formatUsd,
  formatWhen,
  PROBE_LABELS,
  PROBLEM_LABELS,
  ROUTE_LABELS,
  sourceLine,
} from "../format";

export const metadata: Metadata = { title: "Métricas del municipio" };

const PERIOD_LABELS = { "24h": "24 h", "7d": "7 días" } as const;

const routeLabel = (route: string) =>
  (MEASURED_ROUTES as readonly string[]).includes(route)
    ? ROUTE_LABELS[route as MeasuredRoute]
    : route;

/** One municipality (ADR-044): every section says its source and its period. */
export default async function TenantMetricsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly slug: string }>;
  readonly searchParams: Promise<{ readonly buscar?: string | string[] }>;
}) {
  const { gate, session } = await operatorContext();
  if (gate.status === "denied") notFound();
  if (gate.status !== "granted") redirect("/plataforma");

  const { slug } = await params;
  const view = await loadTenantMetrics(
    session.platform,
    session.metrics,
    slug,
    (await searchParams).buscar,
  );
  if (view.status !== "found") notFound();
  const { tenant, metrics, errors, search } = view;
  const at = formatWhen(metrics.generatedAt);
  const base = `/plataforma/metricas/${tenant.slug}`;

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <header className="admin-header">
        <Link href="/plataforma/metricas" className="eyebrow">
          ← Métricas por municipio
        </Link>
        <SignOutButton />
      </header>
      <div className="branding-heading">
        <h1 className="title title-sm">{tenant.displayName}</h1>
        <p className="lead">Cifras hasta las {at} (hora de Bolivia).</p>
      </div>

      <section aria-labelledby="errores" className="metrics-section">
        <h2 id="errores">Errores del servidor</h2>
        <p>
          {formatCount(metrics.errors.last24h)} en las últimas 24 h y{" "}
          {formatCount(metrics.errors.last7d)} en 7 días.
        </p>
        {metrics.errors.byRoute.length > 0 ? (
          <ul className="metrics-list" aria-label="Errores por ruta en 7 días">
            {metrics.errors.byRoute.map((entry) => (
              <li key={`${entry.surface}:${entry.route}`}>
                <code>{entry.route}</code>: {formatCount(entry.count)}
              </li>
            ))}
          </ul>
        ) : null}
        <ErrorsTable errors={errors} search={search} action={base} />
        <p className="metrics-sources">
          {sourceLine(
            "errores del servidor con su ID de petición y su código de referencia (request_errors)",
            `24 h y 7 días hasta las ${at}; la lista, los últimos 50 de 30 días`,
          )}
        </p>
      </section>

      <section aria-labelledby="rutas" className="metrics-section">
        <h2 id="rutas">Tiempos de las rutas</h2>
        {metrics.routes.length === 0 ? (
          <p className="notice" role="status">
            Ningún pedido medido en 7 días.
          </p>
        ) : (
          <div className="table-wrap" role="region" aria-label="Tiempos de las rutas" tabIndex={0}>
            <table className="data-table metrics-table">
              <caption className="visually-hidden">Tiempos de las rutas del servidor</caption>
              <thead>
                <tr>
                  <th scope="col">Ruta</th>
                  <th scope="col">Período</th>
                  <th scope="col">Pedidos</th>
                  <th scope="col">Con error</th>
                  <th scope="col">Promedio</th>
                  <th scope="col">p50</th>
                  <th scope="col">p95</th>
                </tr>
              </thead>
              <tbody>
                {metrics.routes.map((row) => (
                  <tr key={`${row.route}:${row.period}`}>
                    <th scope="row">{routeLabel(row.route)}</th>
                    <td>{PERIOD_LABELS[row.period]}</td>
                    <td>{formatCount(row.requests)}</td>
                    <td>{formatCount(row.errors)}</td>
                    <td>{formatMs(row.avgMs)}</td>
                    <td>{formatBucket(row.p50Ms)}</td>
                    <td>{formatBucket(row.p95Ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="metrics-sources">
          {sourceLine(
            "resumen por hora de cada pedido que atiende el servidor (route_latency_hourly); p50 y p95 son el límite del tramo que los contiene (≤ 50, 100, 200, 400, 800, 1.600, 3.200 y 6.400 ms)",
            `24 h y 7 días hasta las ${at}`,
          )}
        </p>
      </section>

      <section aria-labelledby="sonda" className="metrics-section">
        <h2 id="sonda">Sonda diaria del portal</h2>
        {metrics.probes.length === 0 ? (
          <p className="notice" role="status">
            Todavía no corrió: corre cada día a las 03:27 (hora de Bolivia) para los municipios en
            línea.
          </p>
        ) : (
          <div className="table-wrap" role="region" aria-label="Sonda diaria" tabIndex={0}>
            <table className="data-table metrics-table">
              <caption className="visually-hidden">Última sonda del portal</caption>
              <thead>
                <tr>
                  <th scope="col">Qué</th>
                  <th scope="col">Respuesta</th>
                  <th scope="col">Primer byte</th>
                  <th scope="col">Total</th>
                  <th scope="col">Peso</th>
                  <th scope="col">Caché</th>
                  <th scope="col">Cuándo</th>
                </tr>
              </thead>
              <tbody>
                {metrics.probes.map((probe) => (
                  <tr key={probe.target}>
                    <th scope="row">
                      {PROBE_LABELS[probe.target]}
                      <span className="org-detail">
                        <code>{probe.path}</code>
                      </span>
                    </th>
                    <td>
                      {probe.status ??
                        (probe.error === "timeout" ? "Tardó más de 15 s" : "Sin conexión")}
                    </td>
                    <td>{formatMs(probe.ttfbMs)}</td>
                    <td>{formatMs(probe.totalMs)}</td>
                    <td>{formatBytes(probe.bytes)}</td>
                    <td>{probe.cache ?? "—"}</td>
                    <td>{formatWhen(probe.probedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="metrics-sources">
          {sourceLine(
            "pedido de la plataforma desde São Paulo (portal_probes); mide el servidor y la red de Vercel, no el teléfono del visitante",
            "la última corrida de cada uno, con su hora",
          )}
        </p>
      </section>

      <section aria-labelledby="trabajos" className="metrics-section">
        <h2 id="trabajos">Trabajos</h2>
        <p>
          Ahora: {countOf(metrics.jobsWaiting.ready, "listo esperando", "listos esperando")}
          {metrics.jobsWaiting.oldestWaitSeconds !== null
            ? ` (el más antiguo, desde hace ${formatMs(metrics.jobsWaiting.oldestWaitSeconds * 1000)})`
            : ""}{" "}
          y {formatCount(metrics.jobsWaiting.deadLetterOpen)} en la cola de fallidos.{" "}
          <Link href="/plataforma/trabajos">Ver los trabajos</Link>
        </p>
        {metrics.jobs.length > 0 ? (
          <div className="table-wrap" role="region" aria-label="Trabajos por tipo" tabIndex={0}>
            <table className="data-table metrics-table">
              <caption className="visually-hidden">Trabajos por tipo en 7 días</caption>
              <thead>
                <tr>
                  <th scope="col">Tipo</th>
                  <th scope="col">Encolados</th>
                  <th scope="col">Terminados</th>
                  <th scope="col">Fallidos</th>
                  <th scope="col">En curso o esperando</th>
                  <th scope="col">p95 de un intento</th>
                </tr>
              </thead>
              <tbody>
                {metrics.jobs.map((job) => (
                  <tr key={job.kind}>
                    <th scope="row">
                      <code>{job.kind}</code>
                    </th>
                    <td>{formatCount(job.created)}</td>
                    <td>{formatCount(job.succeeded)}</td>
                    <td>{formatCount(job.deadLetter)}</td>
                    <td>{formatCount(job.pending + job.running)}</td>
                    <td>{formatMs(job.p95AttemptMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="metrics-sources">
          {sourceLine(
            "ledger de trabajos (background_jobs y job_attempts)",
            `trabajos encolados en 7 días hasta las ${at}; «ahora», en ese momento`,
          )}
        </p>
      </section>

      <section aria-labelledby="ia" className="metrics-section">
        <h2 id="ia">Asistente con IA</h2>
        <p>
          Plan actual de Groq: gratuito (0 USD). Lo que sigue es lo que costaría con la tarifa
          pública. {formatCount(metrics.aiRejected7d)} preguntas o dictados sin responder en 7 días
          (cuota, límite del visitante o proveedor). La cuota del día está en{" "}
          <Link href="/plataforma/cuotas">Cuotas por municipio</Link>.
        </p>
        {metrics.ai.length === 0 ? (
          <p className="notice" role="status">
            Ninguna llamada al modelo en 7 días.
          </p>
        ) : (
          <div className="table-wrap" role="region" aria-label="Uso de la IA" tabIndex={0}>
            <table className="data-table metrics-table">
              <caption className="visually-hidden">Uso y costo estimado de la IA</caption>
              <thead>
                <tr>
                  <th scope="col">Modelo</th>
                  <th scope="col">Período</th>
                  <th scope="col">Llamadas</th>
                  <th scope="col">Tokens (entrada / salida)</th>
                  <th scope="col">Audio</th>
                  <th scope="col">Costo estimado</th>
                  <th scope="col">p95</th>
                </tr>
              </thead>
              <tbody>
                {metrics.ai.map((row) => (
                  <tr key={`${row.model}:${row.period}`}>
                    <th scope="row">
                      <code>{row.model}</code>
                    </th>
                    <td>{PERIOD_LABELS[row.period]}</td>
                    <td>
                      {formatCount(row.calls)}
                      {row.failed > 0 ? (
                        <span className="org-detail">
                          {countOf(row.failed, "fallida", "fallidas")}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {formatCount(row.inputTokens)} / {formatCount(row.outputTokens)}
                    </td>
                    <td>{row.audioSeconds > 0 ? `${formatCount(row.audioSeconds)} s` : "—"}</td>
                    <td>
                      {row.unpriced === row.calls ? "Sin tarifa" : formatUsd(row.costUsd)}
                      {row.priceVersions.length > 0 ? (
                        <span className="org-detail">Tarifa {row.priceVersions.join(", ")}</span>
                      ) : null}
                    </td>
                    <td>{formatMs(row.p95LatencyMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="metrics-sources">
          {sourceLine(
            "cada llamada al proveedor (ai_executions) con el costo calculado al registrarla con la tarifa vigente (ai_prices); los pedidos sin responder, de ai_requests",
            `24 h y 7 días hasta las ${at}`,
          )}
        </p>
      </section>

      <section aria-labelledby="integridad" className="metrics-section">
        <h2 id="integridad">Lo publicado está completo</h2>
        {metrics.check === null ? (
          <p className="notice" role="status">
            Todavía no se revisó: corre cada día a las 03:57 (hora de Bolivia) para los municipios
            en línea.
          </p>
        ) : (
          <>
            <p>
              Revisado {formatWhen(metrics.check.checkedAt)} (
              {metrics.check.trigger === "manual" ? "a pedido" : "revisión diaria"}, en{" "}
              {formatMs(metrics.check.durationMs)}): {formatCount(metrics.check.checked.contents)}{" "}
              publicaciones, {formatCount(metrics.check.checked.photos)} fotos,{" "}
              {formatCount(metrics.check.checked.tours)} tours y{" "}
              {metrics.check.checked.logo > 0 ? "el logo" : "sin logo"}.
            </p>
            {metrics.check.problemCount === 0 ? (
              <p className="notice" role="status">
                Todo lo publicado tiene sus archivos públicos y el asistente ya lo leyó.
              </p>
            ) : (
              <>
                <p className="field-error">
                  {formatCount(metrics.check.problemCount)} por revisar
                  {metrics.check.problemCount > metrics.check.problems.length
                    ? ` (se muestran ${formatCount(metrics.check.problems.length)})`
                    : ""}
                  .
                </p>
                <ul className="metrics-list" aria-label="Por revisar">
                  {metrics.check.problems.map((problem, index) => (
                    <li key={`${problem.kind}:${index}`}>
                      <strong>{PROBLEM_LABELS[problem.kind] ?? problem.kind}</strong>:{" "}
                      {problem.title ?? "—"}
                      {problem.detail ? <span className="org-detail">{problem.detail}</span> : null}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
        <CheckPublicationButton tenantId={tenant.tenantId} />
        <p className="metrics-sources">
          {sourceLine(
            "revisión de las revisiones publicadas contra los archivos del almacenamiento y el índice del asistente (publication_checks)",
            "la última revisión, con su hora",
          )}
        </p>
      </section>
    </main>
  );
}
