"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { finishEvaluationAction } from "./actions";

/** Closes a run: its results stay, nothing more can be recorded. */
export function FinishButton({ runId }: { readonly runId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!confirming) {
    return (
      <button
        key="ask"
        type="button"
        className="button button-quiet"
        onClick={() => setConfirming(true)}
      >
        Terminar la corrida
      </button>
    );
  }
  return (
    <div>
      <p>¿Terminar la corrida? Sus resultados quedan, pero ya no se puede correr ni calificar.</p>
      <button
        key="confirm"
        type="button"
        className="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await finishEvaluationAction(runId);
            if (result.status === "finished") router.refresh();
            else setMessage("No pudimos terminar la corrida.");
          })
        }
      >
        Sí, terminar
      </button>{" "}
      <button
        key="cancel"
        type="button"
        className="button button-quiet"
        onClick={() => setConfirming(false)}
      >
        Cancelar
      </button>
      <p className="field-error" role="status">
        {message ?? ""}
      </p>
    </div>
  );
}
