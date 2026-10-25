"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { runQueueNowAction, type RunQueueState } from "./actions";

function summary(state: RunQueueState): string | null {
  switch (state.status) {
    case "done": {
      if (!state.claimed) return "No había trabajos listos para correr.";
      const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
      const parts = [
        plural(state.claimed, "trabajo tomado", "trabajos tomados"),
        plural(state.succeeded ?? 0, "terminado", "terminados"),
      ];
      if (state.retried) parts.push(plural(state.retried, "se reintentará", "se reintentarán"));
      if (state.deadLettered) parts.push(plural(state.deadLettered, "fallido", "fallidos"));
      return `${parts.join(", ")}.`;
    }
    case "not_configured":
      return "El ejecutor no está configurado en este despliegue (faltan WORKER_DATABASE_URL y JOB_RUNNER_SECRET).";
    case "forbidden":
      return "Tu sesión de operador ya no es válida. Recarga la página.";
    case "error":
      return "El ejecutor no pudo terminar. Revisa los registros; lo pendiente sigue en la cola.";
    default:
      return null;
  }
}

/** Runs the queue once from the panel (the database also wakes the runner on its own). */
export function RunQueueButton({ configured }: { readonly configured: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<RunQueueState>({ status: "idle" });
  const [running, startTransition] = useTransition();

  useEffect(() => {
    if (state.status === "done") router.refresh();
  }, [state, router]);

  const message = configured ? summary(state) : summary({ status: "not_configured" });

  return (
    <div className="inline-form run-queue">
      <button
        type="button"
        className="button"
        disabled={running || !configured}
        onClick={() => startTransition(async () => setState(await runQueueNowAction()))}
      >
        {running ? "Procesando…" : "Procesar la cola ahora"}
      </button>
      <span className="org-detail" role="status">
        {message}
      </span>
    </div>
  );
}
