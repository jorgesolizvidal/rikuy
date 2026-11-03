"use client";

import { useId, useState, useTransition } from "react";

import { evaluateGoldAction, type GoldRunState } from "./actions";

type RunCase = Extract<GoldRunState, { status: "done" }>["cases"][number];

const PROBLEMS: Readonly<Record<string, string>> = {
  forbidden: "Hace falta la verificación en dos pasos de operador.",
  not_found: "No encontramos esa demo.",
  not_ready: "La evaluación es para una demo en línea con su dirección del portal.",
  invalid: "Elige un caso entre 1 y 40.",
  error: "No pudimos correr la evaluación. Inténtalo de nuevo en unos minutos.",
};

function verdict(entry: RunCase): string {
  return entry.pass === null ? "Sin evaluar" : entry.pass ? "Bien" : "Mal";
}

/** Runs the gold five cases at a time and keeps every result of this visit together. */
export function GoldRunner({
  demos,
  total,
}: {
  readonly demos: readonly { readonly tenantId: string; readonly displayName: string }[];
  readonly total: number;
}) {
  const ids = useId();
  const [tenantId, setTenantId] = useState(demos[0]?.tenantId ?? "");
  const [from, setFrom] = useState(1);
  const [results, setResults] = useState<RunCase[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  function run() {
    setMessage(null);
    setCopied(false);
    startTransition(async () => {
      const outcome = await evaluateGoldAction(tenantId, from);
      if (outcome.status !== "done") {
        setMessage(PROBLEMS[outcome.status] ?? PROBLEMS.error ?? "");
        return;
      }
      setResults((current) =>
        [
          ...current.filter((entry) => !outcome.cases.some((next) => next.id === entry.id)),
          ...outcome.cases,
        ].sort((a, b) => a.id.localeCompare(b.id)),
      );
      if (outcome.next !== null) setFrom(outcome.next);
      setMessage(
        outcome.next === null
          ? "Listo: se evaluaron los últimos casos."
          : `Listo. La siguiente tanda empieza en el caso ${outcome.next}.`,
      );
    });
  }

  const graded = results.filter((entry) => entry.pass !== null);
  const passed = graded.filter((entry) => entry.pass === true).length;
  const tokens = results.reduce((sum, entry) => sum + entry.tokens, 0);
  const summary = `${passed} de ${graded.length} bien${results.length > graded.length ? ` (${results.length - graded.length} sin evaluar)` : ""} · ${tokens.toLocaleString("es-BO")} tokens`;

  async function copy() {
    const lines = [
      `Gold del asistente: ${summary}`,
      ...results.map(
        (entry) =>
          `${entry.id} [${entry.category}] ${verdict(entry)}${entry.problems.length ? ` — ${entry.problems.join("; ")}` : ""}\n  P: ${entry.question}\n  R: ${entry.answer}\n  Citó: ${entry.cited.join(", ") || "nada"} · Leyó: ${entry.retrieved.join(", ") || "nada"}${entry.planned ? " · reformuló" : ""} · ${entry.tokens} tokens · ${(entry.latencyMs / 1000).toFixed(1)} s`,
      ),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section aria-labelledby={`${ids}-title`} className="gold-runner">
      <h2 id={`${ids}-title`} className="visually-hidden">
        Correr el gold
      </h2>
      <div className="invite-form">
        <div className="field">
          <label htmlFor={`${ids}-demo`}>Demo</label>
          <select
            id={`${ids}-demo`}
            value={tenantId}
            disabled={pending}
            onChange={(event) => {
              setTenantId(event.target.value);
              setResults([]);
              setFrom(1);
            }}
          >
            {demos.map((demo) => (
              <option key={demo.tenantId} value={demo.tenantId}>
                {demo.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${ids}-from`}>Desde el caso</label>
          <input
            id={`${ids}-from`}
            type="number"
            min={1}
            max={total}
            value={from}
            disabled={pending}
            onChange={(event) => setFrom(Number(event.target.value))}
          />
        </div>
        <button
          type="button"
          className="button"
          disabled={pending || tenantId === ""}
          onClick={run}
        >
          {pending ? "Evaluando… (cerca de un minuto y medio)" : "Evaluar 5 casos"}
        </button>
      </div>
      <p
        className={message && !message.startsWith("Listo") ? "field-error" : "field-hint"}
        role="status"
      >
        {message ?? ""}
      </p>

      {results.length > 0 ? (
        <>
          <p>
            <strong>{summary}</strong>{" "}
            <button type="button" className="button button-quiet" onClick={() => void copy()}>
              {copied ? "Copiado" : "Copiar resultados"}
            </button>
          </p>
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Resultados del gold">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Caso</th>
                  <th scope="col">Pregunta y respuesta</th>
                  <th scope="col">Resultado</th>
                </tr>
              </thead>
              <tbody>
                {results.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      {entry.id}
                      <span className="cell-detail"> {entry.category}</span>
                    </td>
                    <td>
                      <p>
                        <strong>{entry.question}</strong>
                      </p>
                      <p>{entry.answer}</p>
                      <p className="cell-detail">
                        Citó: {entry.cited.join(", ") || "nada"} · {entry.tokens} tokens ·{" "}
                        {(entry.latencyMs / 1000).toFixed(1)} s{entry.planned ? " · reformuló" : ""}
                      </p>
                    </td>
                    <td>
                      <span
                        className="status-pill"
                        data-status={
                          entry.pass === null ? "draft" : entry.pass ? "published" : "failed"
                        }
                      >
                        {verdict(entry)}
                      </span>
                      {entry.problems.length > 0 ? (
                        <p className="cell-detail">{entry.problems.join("; ")}</p>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}
