"use client";

import { OPENING_HOURS_LIMITS, openingHoursText, weekdayName } from "@rikuy/core";
import { useId } from "react";

import { fromHoursValues, type DayValues, type HoursRange, type HoursValues } from "./hours-values";

export type { HoursValues } from "./hours-values";

/**
 * Opening hours of a destination (ADR-039): none («sin horario publicado»), always open, or
 * by day with up to two ranges. The assistant's plans use them («Abierto ahora», never a
 * closed place); the visitor sees them on the destination's page.
 */

const MODES = [
  { mode: "none", label: "Sin horario publicado" },
  { mode: "always", label: "Siempre abierto (por ejemplo, un espacio al aire libre)" },
  { mode: "weekly", label: "Por días" },
] as const;

export function HoursField({
  value,
  disabled,
  error,
  onChange,
}: {
  readonly value: HoursValues;
  readonly disabled: boolean;
  readonly error?: string | undefined;
  readonly onChange: (value: HoursValues) => void;
}) {
  const id = useId();
  const set = (patch: Partial<HoursValues>) => onChange({ ...value, ...patch });
  const setDay = (index: number, patch: Partial<DayValues>) =>
    set({ days: value.days.map((day, i) => (i === index ? { ...day, ...patch } : day)) });
  const setRange = (index: number, rangeIndex: number, patch: Partial<HoursRange>) => {
    const day = value.days[index];
    if (!day) return;
    setDay(index, {
      ranges: day.ranges.map((range, i) => (i === rangeIndex ? { ...range, ...patch } : range)),
    });
  };
  const hours = fromHoursValues(value);
  let preview: string | null = null;
  try {
    preview =
      hours && (hours.mode === "always" || hours.days.some((day) => day.length > 0))
        ? openingHoursText(hours)
        : null;
  } catch {
    preview = null;
  }

  return (
    <fieldset disabled={disabled} className="hours-field" aria-describedby={`${id}-hint`}>
      <legend>Horario de atención</legend>
      <p id={`${id}-hint`} className="field-hint">
        En la hora del municipio. Los visitantes ven si está abierto ahora, y el asistente no
        recomienda ir mientras esté cerrado. Sin horario, avisa que hay que confirmarlo.
      </p>
      <div className="hours-modes" role="radiogroup" aria-label="Tipo de horario">
        {MODES.map((option) => (
          <label key={option.mode} className="checkbox">
            <input
              type="radio"
              name={`${id}-mode`}
              value={option.mode}
              checked={value.mode === option.mode}
              onChange={() => set({ mode: option.mode })}
            />
            {option.label}
          </label>
        ))}
      </div>

      {value.mode === "weekly" ? (
        <div className="hours-week">
          {value.days.map((day, index) => {
            const name = weekdayName(index);
            const label = name.charAt(0).toLocaleUpperCase("es") + name.slice(1);
            return (
              <div key={index} className="hours-day" data-open={day.open}>
                <label className="checkbox hours-day-name">
                  <input
                    type="checkbox"
                    checked={day.open}
                    onChange={(event) => setDay(index, { open: event.target.checked })}
                  />
                  {label}
                </label>
                {day.open ? (
                  <div className="hours-ranges">
                    {day.ranges.map((range, rangeIndex) => (
                      <div key={rangeIndex} className="hours-range">
                        <label>
                          <span className="visually-hidden">
                            {label}, {rangeIndex === 0 ? "abre" : "vuelve a abrir"}
                          </span>
                          <input
                            type="time"
                            value={range.from}
                            required
                            onChange={(event) =>
                              setRange(index, rangeIndex, { from: event.target.value })
                            }
                          />
                        </label>
                        <span aria-hidden="true">a</span>
                        <label>
                          <span className="visually-hidden">
                            {label}, {rangeIndex === 0 ? "cierra" : "cierra otra vez"}
                          </span>
                          <input
                            type="time"
                            value={range.to}
                            required
                            onChange={(event) =>
                              setRange(index, rangeIndex, { to: event.target.value })
                            }
                          />
                        </label>
                        {rangeIndex === 1 ? (
                          <button
                            type="button"
                            className="button button-quiet button-small"
                            onClick={() => setDay(index, { ranges: day.ranges.slice(0, 1) })}
                          >
                            Quitar
                            <span className="visually-hidden"> el segundo horario del {name}</span>
                          </button>
                        ) : null}
                      </div>
                    ))}
                    {day.ranges.length < OPENING_HOURS_LIMITS.rangesPerDay ? (
                      <button
                        type="button"
                        className="button button-quiet button-small"
                        onClick={() =>
                          setDay(index, {
                            ranges: [...day.ranges, { from: "14:00", to: "18:00" }],
                          })
                        }
                      >
                        Agregar otro horario<span className="visually-hidden"> el {name}</span>
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <span className="hours-closed">Cerrado</span>
                )}
              </div>
            );
          })}
          <button
            type="button"
            className="button button-quiet"
            onClick={() => {
              const monday = value.days[0];
              if (monday) set({ days: value.days.map(() => monday) });
            }}
          >
            Copiar el lunes a todos los días
          </button>
          <p className="field-hint">Para cerrar a medianoche, escribe 00:00.</p>
        </div>
      ) : null}

      {value.mode !== "none" ? (
        <div className="field">
          <label htmlFor={`${id}-note`}>Nota (opcional)</label>
          <input
            id={`${id}-note`}
            value={value.note}
            maxLength={OPENING_HOURS_LIMITS.note}
            placeholder="Por ejemplo: cerrado los feriados"
            onChange={(event) => set({ note: event.target.value })}
          />
        </div>
      ) : null}

      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : preview ? (
        <p className="field-hint" aria-live="polite">
          Se verá así: {preview}
        </p>
      ) : null}
    </fieldset>
  );
}
