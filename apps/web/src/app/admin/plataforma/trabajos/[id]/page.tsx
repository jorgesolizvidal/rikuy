import { loadJobAttempts } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { operatorContext } from "@/server/operator";

import { SignOutButton } from "../../../sign-out-button";
import { DATE, OUTCOME_LABELS } from "../labels";

export const metadata: Metadata = { title: "Intentos de un trabajo" };

interface JobAttemptsPageProps {
  readonly params: Promise<{ id: string }>;
}

function duration(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1).replace(".", ",")} s`;
}

export default async function JobAttemptsPage({ params }: JobAttemptsPageProps) {
  const { gate, session } = await operatorContext();
  if (gate.status === "denied") notFound();
  if (gate.status !== "granted") redirect("/plataforma");

  const { id } = await params;
  const attempts = await loadJobAttempts(session.jobs, id);
  if (attempts === null) notFound();

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <header className="admin-header">
        <Link href="/plataforma/trabajos" className="eyebrow">
          ← Trabajos en segundo plano
        </Link>
        <SignOutButton />
      </header>
      <h1 className="title title-sm">Intentos</h1>
      <p className="lead">
        Cada vez que un ejecutor tomó este trabajo, del más reciente al más antiguo. Un reintento
        hecho a mano empieza una ronda nueva y conserva las anteriores.
      </p>

      {attempts.length === 0 ? (
        <p className="notice">
          Todavía ningún ejecutor tomó este trabajo. Los intentos aparecen aquí en cuanto empiecen.
        </p>
      ) : (
        <div className="table-wrap" role="region" aria-label="Intentos" tabIndex={0}>
          <table className="data-table">
            <caption className="visually-hidden">Intentos del trabajo</caption>
            <thead>
              <tr>
                <th scope="col">Intento</th>
                <th scope="col">Resultado</th>
                <th scope="col">Duración</th>
                <th scope="col">Error</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((attempt) => (
                <tr key={`${attempt.generation}-${attempt.attemptNo}`}>
                  <td>
                    {attempt.generation > 1 ? `Ronda ${attempt.generation}, ` : ""}intento{" "}
                    {attempt.attemptNo}
                    <span className="org-detail">{DATE.format(new Date(attempt.startedAt))}</span>
                    <span className="org-detail">
                      <code>{attempt.runnerId}</code>
                    </span>
                  </td>
                  <td>
                    <span className="status-pill" data-status={attempt.outcome}>
                      {OUTCOME_LABELS[attempt.outcome]}
                    </span>
                  </td>
                  <td>{duration(attempt.durationMs)}</td>
                  <td>
                    {attempt.errorCode ? (
                      <>
                        <code>{attempt.errorCode}</code>
                        {attempt.errorMessage ? (
                          <span className="org-detail">{attempt.errorMessage}</span>
                        ) : null}
                      </>
                    ) : (
                      <span className="org-detail">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
