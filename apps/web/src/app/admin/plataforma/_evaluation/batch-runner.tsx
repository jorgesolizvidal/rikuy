"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

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

/** Runs the next batch; the page shows every result as it lands. */
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
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run() {
    setMessage(null);
    startTransition(async () => {
      const result = await runBatchAction({ suite, runId });
      if (result.status !== "done" || !("ran" in result)) {
        setMessage(PROBLEMS[result.status] ?? PROBLEMS.error ?? "");
        return;
      }
      const passed = result.ran.filter((entry) => entry.pass === true).length;
      setMessage(
        result.ran.length === 0
          ? "No queda nada por correr."
          : `Listo: ${passed} de ${result.ran.length} bien. Quedan ${result.remaining}.`,
      );
      router.refresh();
    });
  }

  return (
    <div>
      <button type="button" className="button" disabled={pending || remaining === 0} onClick={run}>
        {pending
          ? "Evaluando… (cerca de un minuto y medio)"
          : remaining === 0
            ? "No queda nada por correr"
            : `Correr la siguiente tanda (quedan ${remaining})`}
      </button>
      <p
        className={
          message?.startsWith("Listo") || message?.startsWith("No queda")
            ? "field-hint"
            : "field-error"
        }
        role="status"
      >
        {message ?? ""}
      </p>
    </div>
  );
}
