"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { rateAnswerAction } from "./actions";

/**
 * The operator's 1–5 rating of a held-out answer: clarity and cultural adequacy. After each
 * saved rating the page refreshes, so the report and «Copiar resultados» count it.
 */
export function RatingSelect({
  runId,
  caseId,
  repetition,
  rating,
  disabled,
}: {
  readonly runId: string;
  readonly caseId: string;
  readonly repetition: number;
  readonly rating: number | null;
  readonly disabled: boolean;
}) {
  const id = useId();
  const router = useRouter();
  const [value, setValue] = useState(rating === null ? "" : String(rating));
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <div className="field">
      <label htmlFor={id} className="visually-hidden">
        Nota de la respuesta {caseId}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled || pending}
        onChange={(event) => {
          const next = event.target.value;
          setValue(next);
          setFailed(false);
          startTransition(async () => {
            const result = await rateAnswerAction({
              runId,
              caseId,
              repetition,
              rating: next === "" ? null : Number(next),
            });
            if (result.status === "rated") router.refresh();
            else setFailed(true);
          });
        }}
      >
        <option value="">Sin nota</option>
        <option value="5">5 · muy clara</option>
        <option value="4">4 · clara</option>
        <option value="3">3 · se entiende</option>
        <option value="2">2 · confusa</option>
        <option value="1">1 · mala</option>
      </select>
      {failed ? (
        <p className="field-error" role="status">
          No se guardó.
        </p>
      ) : null}
    </div>
  );
}
