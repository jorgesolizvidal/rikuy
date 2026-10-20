import { listPlatformTenants, loadJobsOverview } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { operatorContext } from "@/server/operator";

import { SignOutButton } from "../../sign-out-button";
import { ProbeForm } from "./probe-form";
import { ReplayButton } from "./replay-button";
import { ago, DATE, FILTERS, STATUS_LABELS } from "./labels";

export const metadata: Metadata = { title: "Trabajos en segundo plano" };

/** ADR-014 alarm: due work waiting this long means no runner is taking it. */
const STUCK_AFTER_MS = 5 * 60_000;

interface JobsPageProps {
  readonly searchParams: Promise<{ estado?: string }>;
}

export default async function JobsPage({ searchParams }: JobsPageProps) {
  const { gate, session } = await operatorContext();
  if (gate.status === "denied") notFound();
  // Second factor pending: the gate lives on the platform home (page redirect, not an action).
  if (gate.status !== "granted") redirect("/plataforma");

  const { estado } = await searchParams;
  const [overview, tenants] = await Promise.all([
    loadJobsOverview(session.jobs, { status: estado }),
    listPlatformTenants(session.platform),
  ]);
  const { summary, jobs, status } = overview;
  // The database's clock, not the server's: it decides leases and retries.
  const now = new Date(summary.checkedAt).getTime();
  const stuck =
    summary.oldestDueAt !== null && now - new Date(summary.oldestDueAt).getTime() > STUCK_AFTER_MS;

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <header className="admin-header">
        <Link href="/plataforma" className="eyebrow">
          ← Plataforma
        </Link>
        <SignOutButton />
      </header>

      <div className="branding-heading">
        <h1 className="title title-sm">Trabajos en segundo plano</h1>
        <p className="lead">
          Lo que la plataforma procesa fuera de las páginas: imágenes grandes, panoramas, modelos
          3D. Cada trabajo queda registrado; si falla, se vuelve a intentar solo, y si no lo logra
          queda en «Fallidos» para que lo revises.
        </p>
      </div>

      <dl className="job-summary">
        <div>
          <dt>En espera</dt>
          <dd>{summary.pending}</dd>
          <dd className="org-detail">
            {summary.pending === 0
              ? "Ninguno"
              : summary.due === summary.pending
                ? "Listos para correr"
                : `${summary.due} listos; el resto espera su reintento`}
          </dd>
        </div>
        <div>
          <dt>En curso</dt>
          <dd>{summary.running}</dd>
        </div>
        <div data-alert={summary.deadLetter > 0}>
          <dt>Fallidos</dt>
          <dd>{summary.deadLetter}</dd>
          <dd className="org-detail">
            {summary.deadLetter > 0 ? "Necesitan revisión" : "Ninguno"}
          </dd>
        </div>
        <div>
          <dt>Terminados (24 h)</dt>
          <dd>{summary.succeededLastDay}</dd>
        </div>
      </dl>

      {stuck && summary.oldestDueAt ? (
        <p className="notice" role="alert">
          Hay trabajos listos esperando desde {ago(summary.oldestDueAt, now)}: ningún ejecutor los
          está tomando. Revisa el ejecutor siguiendo el runbook de trabajos.
        </p>
      ) : null}

      <nav aria-label="Filtrar por estado" className="filter-tabs">
        {FILTERS.map((filter) => (
          <Link
            key={filter.label}
            href={
              filter.status
                ? `/plataforma/trabajos?estado=${filter.status}`
                : "/plataforma/trabajos"
            }
            aria-current={filter.status === status ? "page" : undefined}
          >
            {filter.label}
          </Link>
        ))}
      </nav>

      {jobs.length === 0 ? (
        <p className="notice">No hay trabajos {status ? "con este estado" : "todavía"}.</p>
      ) : (
        <div className="table-wrap" role="region" aria-label="Trabajos" tabIndex={0}>
          <table className="data-table">
            <caption className="visually-hidden">Trabajos en segundo plano</caption>
            <thead>
              <tr>
                <th scope="col">Trabajo</th>
                <th scope="col">Estado</th>
                <th scope="col">Intentos</th>
                <th scope="col">Último error</th>
                <th scope="col">
                  <span className="visually-hidden">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.jobId} data-status={job.status}>
                  <td>
                    <span className="org-name">{job.kindDescription}</span>
                    <span className="org-detail">
                      {job.tenantName} · <code>{job.kind}</code>
                    </span>
                    <span className="org-detail">
                      Creado {DATE.format(new Date(job.createdAt))}
                    </span>
                  </td>
                  <td>
                    <span className="status-pill" data-status={job.status}>
                      {STATUS_LABELS[job.status]}
                    </span>
                    {job.status === "pending" && new Date(job.availableAt).getTime() > now ? (
                      <span className="org-detail">
                        Reintento a las {DATE.format(new Date(job.availableAt))}
                      </span>
                    ) : null}
                    {job.finishedAt ? (
                      <span className="org-detail">{DATE.format(new Date(job.finishedAt))}</span>
                    ) : null}
                  </td>
                  <td>
                    {job.attempts} de {job.maxAttempts}
                    {job.generation > 1 ? (
                      <span className="org-detail">Reintentado a mano ({job.generation - 1})</span>
                    ) : null}
                  </td>
                  <td>
                    {job.lastErrorCode ? (
                      <>
                        <code>{job.lastErrorCode}</code>
                        {job.lastErrorMessage ? (
                          <span className="org-detail">{job.lastErrorMessage}</span>
                        ) : null}
                      </>
                    ) : (
                      <span className="org-detail">—</span>
                    )}
                  </td>
                  <td className="cell-actions">
                    <span className="inline-form">
                      <Link href={`/plataforma/trabajos/${job.jobId}`} className="org-detail">
                        Ver intentos
                        <span className="visually-hidden">
                          {" "}
                          de {job.kindDescription} ({job.tenantName})
                        </span>
                      </Link>
                      {job.status === "dead_letter" ? (
                        <ReplayButton
                          jobId={job.jobId}
                          generation={job.generation}
                          label={`${job.kindDescription} de ${job.tenantName}`}
                        />
                      ) : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section aria-labelledby="probe-title" className="branding-heading">
        <h2 id="probe-title">Probar el ejecutor</h2>
        <p className="lead">
          Pone en la cola un trabajo que no cambia nada, para comprobar que el ejecutor toma y
          termina el trabajo, o para ensayar un reintento y la cola de fallidos.
        </p>
        <ProbeForm
          tenants={(tenants ?? []).map((tenant) => ({
            tenantId: tenant.tenantId,
            displayName: tenant.displayName,
          }))}
        />
      </section>
    </main>
  );
}
