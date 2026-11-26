"use client";

import { VISIT_MINUTES, VISIT_MINUTES_CHOICES } from "@rikuy/core";
import { useId } from "react";

/** «1 h 30 min», as the plans say it. */
function minutesLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * «Para tu plan» (ADR-072): how long a visit takes (destinations) and whether it suits a visit
 * with children (destinations and events). The assistant's plans use both: «Tengo 2 horas»
 * respects the time, «Con niños» never includes a place marked as not recommended.
 */
export function PlanFields({
  kind,
  visitMinutes,
  kids,
  disabled,
  error,
  onVisitMinutes,
  onKids,
}: {
  readonly kind: "destination" | "event";
  readonly visitMinutes: number | null;
  readonly kids: boolean | null;
  readonly disabled: boolean;
  readonly error?: string | undefined;
  readonly onVisitMinutes: (minutes: number | null) => void;
  readonly onKids: (kids: boolean | null) => void;
}) {
  const id = useId();
  const kidsValue = kids === null ? "" : kids ? "yes" : "no";
  return (
    <fieldset disabled={disabled}>
      <legend>Para tu plan</legend>
      <p className="field-hint">
        El asistente arma planes como «Tengo 2 horas» o «Con niños» con estos datos. Son opcionales.
      </p>
      {kind === "destination" ? (
        <div className="field">
          <label htmlFor={`${id}-visit`}>Tiempo de visita</label>
          <select
            id={`${id}-visit`}
            value={visitMinutes ?? ""}
            aria-invalid={error ? true : undefined}
            aria-describedby={`${id}-visit-hint${error ? ` ${id}-plan-error` : ""}`}
            onChange={(event) =>
              onVisitMinutes(event.target.value === "" ? null : Number(event.target.value))
            }
          >
            <option value="">Sin indicar ({VISIT_MINUTES.default} min)</option>
            {VISIT_MINUTES_CHOICES.map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutesLabel(minutes)}
              </option>
            ))}
          </select>
          <span id={`${id}-visit-hint`} className="field-hint">
            Cuánto tiempo suele quedarse un visitante. Sin indicarlo, los planes cuentan{" "}
            {VISIT_MINUTES.default} minutos.
          </span>
        </div>
      ) : null}
      <fieldset className="field" aria-describedby={`${id}-kids-hint`}>
        <legend>Para ir con niños</legend>
        <span id={`${id}-kids-hint`} className="field-hint">
          En un plan «Con niños», los lugares no recomendados nunca aparecen y los aptos van
          primero.
        </span>
        <div>
          {(
            [
              ["", "Sin indicar"],
              ["yes", "Apto"],
              ["no", "No recomendado"],
            ] as const
          ).map(([value, label]) => (
            <label key={value || "none"} className="checkbox">
              <input
                type="radio"
                name={`${id}-kids`}
                value={value}
                checked={kidsValue === value}
                onChange={() => onKids(value === "" ? null : value === "yes")}
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      {error ? (
        <p id={`${id}-plan-error`} className="field-error">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
