import {
  ASSISTANT_BATCH,
  COPILOT_BATCH,
  evalFixtureStates,
  evaluationCases,
  HELD_OUT_REPETITIONS,
  SECURITY_REPETITIONS,
  itemsOf,
  loadEvaluation,
  openOrganization,
  type EvalSuite,
  type FixtureState,
} from "@rikuy/core";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { aiGatewayStatus } from "@/server/ai-gateway";
import { operatorContext } from "@/server/operator";

import { SignOutButton } from "../../sign-out-button";
import { BatchRunner } from "./batch-runner";
import { CopyReport } from "./copy-report";
import { FixtureButtons } from "./fixture-buttons";
import { FinishButton } from "./finish-button";
import { RatingSelect } from "./rating-select";
import { StartForm } from "./start-form";

/**
 * One page for both suites (ADR-045): start a run against two demos, prepare the trap data
 * in demo B, run batches, rate the held-out answers and read the report with the audit's
 * criteria. Every figure comes from eval_results.
 */

const TITLES: Readonly<Record<EvalSuite, string>> = {
  assistant: "Evaluar el asistente",
  copilot: "Evaluar el Copilot",
};

const SPLIT_NAMES: Readonly<Record<string, string>> = {
  dev: "Desarrollo",
  heldout: `Reservadas (×${HELD_OUT_REPETITIONS})`,
  security: "Seguridad",
  copilot: "Casos del Copilot",
};

const FIXTURE_STATUS: Readonly<Record<FixtureState["status"], string>> = {
  ready: "Lista",
  missing: "Falta",
  retired: "Retirada",
};

const GATE_STATUS = { pass: "Cumple", fail: "No cumple", pending: "Falta" } as const;
const GATE_PILL = { pass: "published", fail: "failed", pending: "draft" } as const;

function when(iso: string): string {
  return new Intl.DateTimeFormat("es-BO", {
    timeZone: "America/La_Paz",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

export async function EvaluationPage({
  suite,
  runId,
}: {
  readonly suite: EvalSuite;
  readonly runId: string | null;
}) {
  const { actor, gate, session } = await operatorContext();
  if (gate.status === "denied") notFound();
  if (gate.status !== "granted") redirect("/plataforma");
  const [view, tenants] = await Promise.all([
    loadEvaluation(suite, runId, { platform: session.platform, evals: session.evals }),
    session.platform.listTenants(),
  ]);
  if (view === null) notFound();
  const demos = tenants.filter(
    (tenant) => tenant.demo && tenant.status === "active" && tenant.canonicalHost !== null,
  );
  const status = aiGatewayStatus();
  const { run, rows, report } = view;
  const cases = evaluationCases(suite);
  const total = itemsOf(suite, view.scope).length;
  const path = suite === "assistant" ? "/plataforma/asistente" : "/plataforma/copilot";

  let fixtures: FixtureState[] | null = null;
  let fixturesMember = true;
  if (run?.tenantB) {
    const membership = await openOrganization(actor, run.tenantB.slug, session.memberships);
    if (membership === null) fixturesMember = false;
    else fixtures = await evalFixtureStates(membership, session).catch(() => null);
  }

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <header className="admin-header">
        <Link href="/plataforma" className="eyebrow">
          ← Plataforma
        </Link>
        <SignOutButton />
      </header>
      <div className="branding-heading">
        <h1 className="title title-sm">{TITLES[suite]}</h1>
        {suite === "assistant" ? (
          <p className="lead">
            Las 163 preguntas del gold (83 de desarrollo, 40 reservadas que se hacen 3 veces y 40 de
            seguridad) al asistente de dos demos, con el modelo real. Cada respuesta se califica
            sola con sus reglas; las reservadas también las calificas tú, del 1 al 5.
          </p>
        ) : (
          <p className="lead">
            Los {cases.size} casos del Copilot (preguntas y propuestas) sobre dos demos, como lo
            haría alguien del equipo. Cada propuesta se lee y se rechaza al terminar: nunca se
            acepta ni se publica nada, y si algo del contenido cambia, el caso falla.
          </p>
        )}
        <p className="field-hint">
          Corre {suite === "assistant" ? ASSISTANT_BATCH : COPILOT_BATCH} casos por tanda, separados
          para no pasar el límite de tokens por minuto de Groq. Todo cuenta en la cuota de IA de
          cada demo: súbela mientras dure en <Link href="/plataforma/cuotas">Cuotas</Link>. La demo
          B es una segunda demo solo para probar: ahí van los datos trampa.{" "}
          <Link href={suite === "assistant" ? "/plataforma/copilot" : "/plataforma/asistente"}>
            {suite === "assistant" ? "Evaluar el Copilot" : "Evaluar el asistente"}
          </Link>
        </p>
      </div>

      {!status.configured ? (
        <p className="notice" role="status">
          La IA no está configurada en este despliegue: no hay nada que evaluar.
        </p>
      ) : demos.length === 0 ? (
        <p className="notice" role="status">
          No hay ninguna demo en línea. Da de alta una demo comercial, ponla en línea y carga su
          contenido de muestra (con el tour de muestra) antes de evaluar.
        </p>
      ) : (
        <section aria-labelledby="nueva" className="metrics-section">
          <h2 id="nueva">Nueva corrida</h2>
          <StartForm
            suite={suite}
            path={path}
            demos={demos.map((tenant) => ({
              tenantId: tenant.tenantId,
              displayName: tenant.displayName,
            }))}
          />
        </section>
      )}

      {view.runs.length > 1 ? (
        <nav aria-label="Corridas anteriores" className="field-hint">
          Corridas:{" "}
          {view.runs.map((entry, index) => (
            <span key={entry.id}>
              {index > 0 ? " · " : ""}
              {entry.id === run?.id ? (
                <strong>{when(entry.createdAt)}</strong>
              ) : (
                <Link href={`${path}?corrida=${entry.id}`}>{when(entry.createdAt)}</Link>
              )}
            </span>
          ))}
        </nav>
      ) : null}

      {run ? (
        <>
          <section aria-labelledby="corrida" className="metrics-section">
            <h2 id="corrida">
              Corrida del {when(run.createdAt)}
              {view.scope === "security" ? " · solo seguridad" : ""}
            </h2>
            {view.scope === "security" ? (
              <p className="field-hint">
                Solo los 40 casos de seguridad, 3 veces cada uno. Comprueba las protecciones; la
                calidad, los hechos y la revisión del español quedan para el gold completo.
              </p>
            ) : null}
            <p>
              Demo A: <strong>{run.tenantA.displayName}</strong>
              {run.tenantB ? (
                <>
                  {" "}
                  · Demo B: <strong>{run.tenantB.displayName}</strong>
                </>
              ) : (
                " · Sin demo B: los casos de otro municipio y de datos trampa no se corren."
              )}
            </p>
            <p className="field-hint">
              Conjunto {run.dataset} · {run.provider} / {run.model} · {rows.length} de {total}{" "}
              resultados
              {run.finishedAt ? ` · terminada el ${when(run.finishedAt)}` : ""}
            </p>
            {view.outdated ? (
              <p className="notice" role="status">
                Esta corrida es de una versión anterior de los casos: no se puede seguir. Empieza
                una nueva.
              </p>
            ) : run.finishedAt === null ? (
              <div className="eval-actions">
                <BatchRunner suite={suite} runId={run.id} pending={view.pending} />
                <FinishButton runId={run.id} />
              </div>
            ) : null}
          </section>

          {run.tenantB ? (
            <section aria-labelledby="trampa" className="metrics-section">
              <h2 id="trampa">Datos de prueba en {run.tenantB.displayName}</h2>
              {!fixturesMember ? (
                <p className="notice" role="status">
                  Para preparar los datos de prueba tienes que ser propietario o administrador de
                  esa demo (con la verificación en dos pasos).
                </p>
              ) : (
                <>
                  <ul className="eval-fixtures">
                    {(fixtures ?? []).map((fixture) => (
                      <li key={fixture.key}>
                        {fixture.title}: {FIXTURE_STATUS[fixture.status]}
                        {fixture.indexed === false ? " (el asistente todavía la está leyendo)" : ""}
                      </li>
                    ))}
                  </ul>
                  <FixtureButtons tenantId={run.tenantB.id} />
                </>
              )}
            </section>
          ) : null}

          {report ? (
            <section aria-labelledby="informe" className="metrics-section">
              <h2 id="informe">
                Informe:{" "}
                {report.status === "pass"
                  ? "aprobado"
                  : report.status === "fail"
                    ? "no aprobado"
                    : "incompleto"}
              </h2>
              <div className="table-wrap" role="region" aria-label="Criterios" tabIndex={0}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Criterio</th>
                      <th scope="col">Medido</th>
                      <th scope="col">Umbral</th>
                      <th scope="col">Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.gates.map((entry) => (
                      <tr key={entry.id}>
                        <th scope="row">
                          {entry.label}
                          {entry.blocking ? <span className="cell-detail"> (bloquea)</span> : null}
                        </th>
                        <td>{entry.measured}</td>
                        <td>{entry.threshold}</td>
                        <td>
                          <span className="status-pill" data-status={GATE_PILL[entry.status]}>
                            {GATE_STATUS[entry.status]}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="metrics-sources">
                {report.splits.map((split) => (
                  <li key={split.split}>
                    {view.scope === "security" && split.split === "security"
                      ? `Seguridad (×${SECURITY_REPETITIONS})`
                      : (SPLIT_NAMES[split.split] ?? split.split)}
                    : {split.passed} bien de {split.evaluated} evaluados ({split.expected} en total)
                    {split.notEvaluated > 0
                      ? ` · ${split.notEvaluated} sin evaluar (cuota o proveedor): se repiten solos`
                      : ""}
                  </li>
                ))}
                <li>
                  Fuente: resultados de la corrida (eval_results); tokens{" "}
                  {report.tokens.toLocaleString("es-BO")}, costo estimado a la tarifa de pago{" "}
                  {report.estimatedCostUsd.toLocaleString("es-BO", { maximumFractionDigits: 4 })}{" "}
                  USD (plan actual: 0 USD).
                </li>
              </ul>
              <CopyReport
                text={[
                  `${TITLES[suite]}${view.scope === "security" ? " (solo seguridad)" : ""} · ${run.dataset} · ${run.provider}/${run.model}`,
                  `Demo A: ${run.tenantA.displayName}${run.tenantB ? ` · Demo B: ${run.tenantB.displayName}` : ""}`,
                  `Resultado: ${report.status}`,
                  ...report.gates.map(
                    (entry) =>
                      `- ${entry.label}: ${entry.measured} (umbral ${entry.threshold}) → ${GATE_STATUS[entry.status]}`,
                  ),
                  "",
                  ...rows.map(
                    (row) =>
                      `${row.caseId}#${row.repetition} [${row.category}] ${row.pass === null ? "sin evaluar" : row.pass ? "bien" : "mal"}${row.problems.length ? ` — ${row.problems.join("; ")}` : ""}${row.rating ? ` · ${row.rating}/5` : ""}\n  P: ${cases.get(row.caseId)?.question ?? ""}\n  R: ${row.answer.replace(/\s+/gu, " ")}\n  ${row.inputTokens + row.outputTokens} tokens · ${(row.latencyMs / 1000).toFixed(1)} s`,
                  ),
                ].join("\n")}
              />
            </section>
          ) : null}

          {rows.length > 0 ? (
            <section aria-labelledby="resultados" className="metrics-section">
              <h2 id="resultados">Resultados</h2>
              <div className="table-wrap" role="region" aria-label="Resultados" tabIndex={0}>
                <table className="data-table eval-table">
                  <thead>
                    <tr>
                      <th scope="col">Caso</th>
                      <th scope="col">Pregunta y respuesta</th>
                      <th scope="col">Resultado</th>
                      {suite === "assistant" ? <th scope="col">Tu nota</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={`${row.caseId}#${row.repetition}`}>
                        <th scope="row">
                          {row.caseId}
                          {row.split === "heldout" || view.scope === "security"
                            ? ` (${row.repetition})`
                            : ""}
                          <span className="cell-detail"> {row.category}</span>
                        </th>
                        <td>
                          <p>
                            <strong>{cases.get(row.caseId)?.question}</strong>
                          </p>
                          <p className="eval-answer">{row.answer}</p>
                          <p className="cell-detail">
                            {row.inputTokens + row.outputTokens} tokens ·{" "}
                            {(row.latencyMs / 1000).toLocaleString("es-BO", {
                              maximumFractionDigits: 1,
                            })}{" "}
                            s
                            {row.estimatedCostUsd !== null
                              ? ` · ${row.estimatedCostUsd.toLocaleString("es-BO", { maximumFractionDigits: 5 })} USD estimados`
                              : " · sin tarifa"}
                          </p>
                        </td>
                        <td>
                          <span
                            className="status-pill"
                            data-status={
                              row.pass === null ? "draft" : row.pass ? "published" : "failed"
                            }
                          >
                            {row.pass === null ? "Sin evaluar" : row.pass ? "Bien" : "Mal"}
                          </span>
                          {row.problems.length > 0 ? (
                            <p className="cell-detail">{row.problems.join("; ")}</p>
                          ) : null}
                        </td>
                        {suite === "assistant" ? (
                          <td>
                            {row.split === "heldout" &&
                            row.repetition === 1 &&
                            row.pass !== null ? (
                              <RatingSelect
                                runId={run.id}
                                caseId={row.caseId}
                                repetition={row.repetition}
                                rating={row.rating}
                                disabled={run.finishedAt !== null}
                              />
                            ) : null}
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
