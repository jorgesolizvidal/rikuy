import { loadMetricsOverview, loadPlatformErrors, normalizeErrorSearch } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { operatorContext } from "@/server/operator";

import { SignOutButton } from "../../sign-out-button";
import { ErrorsTable } from "./errors-table";
import {
  countOf,
  formatBucket,
  formatCount,
  formatMs,
  formatUsd,
  formatWhen,
  sourceLine,
} from "./format";

export const metadata: Metadata = { title: "Métricas por municipio" };

/**
 * Every municipality at a glance (ADR-044), and the platform's own errors. Each column says
 * where its figure comes from and for what period, under the table.
 */
export default async function MetricsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly buscar?: string | string[] }>;
}) {
  const { gate, session } = await operatorContext();
  if (gate.status === "denied") notFound();
  if (gate.status !== "granted") redirect("/plataforma");

  const search = (await searchParams).buscar;
  const [overview, platformErrors] = await Promise.all([
    loadMetricsOverview(session.platform, session.metrics),
    loadPlatformErrors(session.platform, session.metrics, search),
  ]);
  if (overview === null || platformErrors === null) notFound();
  const at = formatWhen(overview.generatedAt);

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <header className="admin-header">
        <Link href="/plataforma" className="eyebrow">
          ← Plataforma
        </Link>
        <SignOutButton />
      </header>
      <div className="branding-heading">
        <h1 className="title title-sm">Métricas por municipio</h1>
        <p className="lead">
          Errores, tiempos, trabajos, IA e integridad de lo publicado, hasta las {at} (hora de
          Bolivia). Abre un municipio para ver el detalle.
        </p>
      </div>

      <section aria-labelledby="municipios" className="metrics-section">
        <h2 id="municipios">Municipios</h2>
        <div className="table-wrap" role="region" aria-label="Métricas por municipio" tabIndex={0}>
          <table className="data-table metrics-table">
            <caption className="visually-hidden">Resumen de métricas por municipio</caption>
            <thead>
              <tr>
                <th scope="col">Municipio</th>
                <th scope="col">Errores (24 h)</th>
                <th scope="col">Rutas medidas (24 h)</th>
                <th scope="col">Trabajos</th>
                <th scope="col">IA (7 días)</th>
                <th scope="col">Sonda diaria</th>
                <th scope="col">Lo publicado</th>
              </tr>
            </thead>
            <tbody>
              {overview.tenants.map((tenant) => (
                <tr key={tenant.tenantId}>
                  <th scope="row">
                    <Link href={`/plataforma/metricas/${tenant.slug}`}>{tenant.displayName}</Link>
                    {tenant.status !== "active" ? (
                      <span className="org-detail">
                        {tenant.status === "suspended" ? "Suspendido" : "En preparación"}
                      </span>
                    ) : null}
                  </th>
                  <td>{formatCount(tenant.errors24h)}</td>
                  <td>
                    {countOf(tenant.requests24h, "pedido", "pedidos")}
                    <span className="org-detail">p95 {formatBucket(tenant.p95Ms24h)}</span>
                  </td>
                  <td>
                    {countOf(tenant.jobsFailed7d, "fallido", "fallidos")} (7 días)
                    <span className="org-detail">
                      {countOf(tenant.jobsWaiting, "esperando", "esperando")}
                    </span>
                  </td>
                  <td>
                    {countOf(tenant.aiCalls7d, "llamada", "llamadas")}
                    <span className="org-detail">{formatUsd(tenant.aiCostUsd7d)} estimado</span>
                  </td>
                  <td>
                    {tenant.probe ? (
                      <>
                        {tenant.probe.status === null
                          ? "Sin respuesta"
                          : `${tenant.probe.status} · ${formatMs(tenant.probe.ttfbMs)}`}
                        <span className="org-detail">{formatWhen(tenant.probe.probedAt)}</span>
                      </>
                    ) : (
                      "Todavía no"
                    )}
                  </td>
                  <td>
                    {tenant.check ? (
                      <>
                        {tenant.check.problems === 0
                          ? "Completo"
                          : `${formatCount(tenant.check.problems)} por revisar`}
                        <span className="org-detail">{formatWhen(tenant.check.checkedAt)}</span>
                      </>
                    ) : (
                      "Todavía no"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="metrics-sources">
          <li>
            {sourceLine("errores del servidor (request_errors)", `últimas 24 h hasta las ${at}`)}
          </li>
          <li>
            {sourceLine(
              "resumen por hora de las rutas del asistente, el dictado, el mapa y el recorrido (route_latency_hourly); el p95 es el límite del tramo que lo contiene",
              `últimas 24 h hasta las ${at}`,
            )}
          </li>
          <li>
            {sourceLine(
              "trabajos en la cola de fallidos (background_jobs) y trabajos listos esperando",
              `7 días hasta las ${at}; «esperando», ahora`,
            )}
          </li>
          <li>
            {sourceLine(
              "llamadas al modelo (ai_executions) a la tarifa pública versionada; el plan actual de Groq es gratuito (0 USD)",
              `7 días hasta las ${at}`,
            )}
          </li>
          <li>
            {sourceLine(
              "sonda diaria del inicio (portal_probes) y revisión de lo publicado (publication_checks)",
              "su última corrida, con la hora indicada",
            )}
          </li>
        </ul>
      </section>

      <section aria-labelledby="plataforma-errores" className="metrics-section">
        <h2 id="plataforma-errores">Errores sin municipio</h2>
        <p>
          {formatCount(overview.platformErrors.last24h)} en las últimas 24 h y{" "}
          {formatCount(overview.platformErrors.last7d)} en 7 días: la plataforma, el inicio del
          panel o una dirección que no corresponde a ningún municipio.
        </p>
        <ErrorsTable
          errors={platformErrors}
          search={normalizeErrorSearch(search)}
          action="/plataforma/metricas"
        />
        <p className="metrics-sources">
          {sourceLine("errores del servidor (request_errors)", "los últimos 50, de 30 días")}
        </p>
      </section>
    </main>
  );
}
