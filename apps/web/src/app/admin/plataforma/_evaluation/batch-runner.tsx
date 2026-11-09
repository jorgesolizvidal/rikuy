"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { runBatchAction } from "./actions";

const PROBLEMS: Readonly<Record<string, string>> = {
  forbidden: "Hace falta la verificación en dos pasos de operador.",
  not_found: "No encontramos esa corrida.",
  finished: "La corrida ya terminó.",
  outdated: "La corrida es de una versión anterior de los casos: empieza una nueva.",
  not_ready:
    "Las demos tienen que seguir en línea y, para el Copilot, tienes que ser propietario o administrador de las dos.",
  waiting:
    "Lo que falta necesita los datos de prueba de la demo B: prepáralos y espera a que el asistente los lea.",
  signed_out: "Tu sesión terminó: vuelve a entrar.",
  error: "No pudimos correr la tanda. Inténtalo de nuevo en unos minutos.",
};

const NO_ANSWERS =
  "Ninguna pregunta de la tanda tuvo respuesta: se acabó la cuota de IA del día (de una demo o de la plataforma) o el proveedor no responde. Sigue mañana con esta misma corrida: las que no tuvieron respuesta se vuelven a preguntar.";

type Outcome =
  | { readonly kind: "stop"; readonly message: string; readonly ok: boolean }
  | { readonly kind: "more"; readonly message: string };

/**
 * Runs the next batch, or every batch one after another («Correr todas las tandas») until
 * nothing is left, a batch gets no answer at all (the day's quota ran out) or the operator
 * stops it. The page shows every result as it lands.
 */
export function BatchRunner({
  suite,
  runId,
  pending: remaining,
}: {
  readonly suite: string;
  readonly runId: string;
  readonly pending: number;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [looping, setLooping] = useState(false);
  const [pending, startTransition] = useTransition();
  const stop = useRef(false);

  async function once(): Promise<Outcome> {
    let result: Awaited<ReturnType<typeof runBatchAction>>;
    try {
      result = await runBatchAction({ suite, runId });
    } catch {
      // The request failed or the function ran out of time: what was recorded stays.
      return { kind: "stop", message: PROBLEMS.error ?? "", ok: false };
    }
    if (result.status !== "done" || !("ran" in result)) {
      return { kind: "stop", message: PROBLEMS[result.status] ?? PROBLEMS.error ?? "", ok: false };
    }
    router.refresh();
    if (result.ran.length === 0)
      return { kind: "stop", message: "No queda nada por correr.", ok: true };
    const passed = result.ran.filter((entry) => entry.pass === true).length;
    const unanswered = result.ran.filter((entry) => entry.pass === null).length;
    if (unanswered === result.ran.length) return { kind: "stop", message: NO_ANSWERS, ok: false };
    const text = `Listo: ${passed} de ${result.ran.length} bien${unanswered > 0 ? `, ${unanswered} sin respuesta` : ""}. Quedan ${result.remaining}.`;
    // «Quedan» counts only what can run now: the next call says whether anything is left or
    // only what waits for the trap data, so the loop always asks once more.
    return { kind: "more", message: text };
  }

  function runOne() {
    setMessage(null);
    startTransition(async () => {
      const outcome = await once();
      setMessage({ text: outcome.message, ok: outcome.kind === "more" || outcome.ok });
    });
  }

  function runAll() {
    stop.current = false;
    setLooping(true);
    setMessage(null);
    startTransition(async () => {
      for (;;) {
        const outcome = await once();
        if (outcome.kind === "stop") {
          setMessage({ text: outcome.message, ok: outcome.ok });
          break;
        }
        if (stop.current) {
          setMessage({ text: `${outcome.message} Detenido: sigue cuando quieras.`, ok: true });
          break;
        }
        setMessage({ text: `${outcome.message} Corriendo la siguiente…`, ok: true });
      }
      setLooping(false);
    });
  }

  const done = remaining === 0;
  return (
    <div>
      <div className="form-actions">
        <button type="button" className="button" disabled={pending || done} onClick={runAll}>
          {looping
            ? "Corriendo todas las tandas…"
            : done
              ? "No queda nada por correr"
              : `Correr todas las tandas (quedan ${remaining})`}
        </button>
        {looping ? (
          <button
            type="button"
            className="button button-quiet"
            onClick={() => {
              stop.current = true;
            }}
          >
            Detener después de esta tanda
          </button>
        ) : (
          <button
            type="button"
            className="button button-quiet"
            disabled={pending || done}
            onClick={runOne}
          >
            {pending ? "Evaluando… (cerca de un minuto y medio)" : "Correr solo la siguiente tanda"}
          </button>
        )}
      </div>
      {looping ? (
        <p className="field-hint">
          Deja esta página abierta: cada tanda tarda cerca de un minuto y medio y la siguiente
          empieza sola.
        </p>
      ) : null}
      <p className={message === null || message.ok ? "field-hint" : "field-error"} role="status">
        {message?.text ?? ""}
      </p>
    </div>
  );
}
