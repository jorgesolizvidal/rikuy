"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";

import { replayJobAction, type ReplayState } from "./actions";

const MESSAGES: Partial<Record<ReplayState["status"], string>> = {
  stale: "El trabajo cambió mientras tanto. Recarga la página.",
  not_found: "El trabajo ya no existe.",
  forbidden: "Tu sesión de operador ya no es válida. Recarga la página.",
  error: "No se pudo reintentar. Inténtalo de nuevo.",
};

/** «Reintentar» a dead-letter job, after a confirmation step (it runs the work again). */
export function ReplayButton({
  jobId,
  generation,
  label,
}: {
  readonly jobId: string;
  readonly generation: number;
  /** What is being replayed, for screen readers ("la prueba de Demo Sur"). */
  readonly label: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [state, action, pending] = useActionState(replayJobAction, {
    status: "idle",
  } as ReplayState);

  useEffect(() => {
    if (state.status === "replayed") router.refresh();
  }, [state, router]);

  const message = MESSAGES[state.status];

  if (!confirming) {
    return (
      <span className="inline-form">
        <button type="button" className="button button-quiet" onClick={() => setConfirming(true)}>
          Reintentar<span className="visually-hidden"> {label}</span>
        </button>
        {message ? (
          <span className="org-detail" role="status">
            {message}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <form action={action} className="inline-form">
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="generation" value={generation} />
      <span className="org-detail">Se vuelve a hacer el trabajo desde el principio.</span>
      <button type="submit" className="button" disabled={pending}>
        {pending ? "Reintentando…" : "Sí, reintentar"}
      </button>
      <button type="button" className="button button-quiet" onClick={() => setConfirming(false)}>
        Cancelar
      </button>
    </form>
  );
}
