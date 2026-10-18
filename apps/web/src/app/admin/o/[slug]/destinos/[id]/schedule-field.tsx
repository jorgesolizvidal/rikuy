"use client";

import { formatEventSchedule, validateEventDocument } from "@rikuy/core";
import { useId } from "react";

import { toSchedule, type ScheduleValues } from "./schedule-values";

export type { ScheduleValues } from "./schedule-values";

/** A readable preview of the schedule, or null when it is incomplete or invalid. */
function preview(values: ScheduleValues): string | null {
  const schedule = toSchedule(values);
  if (schedule === null) return null;
  const check = validateEventDocument({
    title: "x",
    summary: "",
    body: [],
    location: null,
    cover: null,
    gallery: [],
    schedule,
    venueId: null,
  });
  return check.ok ? formatEventSchedule(schedule) : null;
}

export function ScheduleField({
  value,
  disabled,
  error,
  timezoneNote,
  onChange,
}: {
  readonly value: ScheduleValues;
  readonly disabled: boolean;
  readonly error?: string | undefined;
  readonly timezoneNote: string;
  readonly onChange: (value: ScheduleValues) => void;
}) {
  const id = useId();
  const set = (patch: Partial<ScheduleValues>) => onChange({ ...value, ...patch });
  const shown = preview(value);

  return (
    <fieldset disabled={disabled} className="schedule-field">
      <legend>Fecha y hora</legend>
      <p className="field-hint">
        {timezoneNote} El evento sale solo de la agenda cuando termina. Obligatorio para publicar.
      </p>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={value.allDay}
          onChange={(event) => set({ allDay: event.target.checked })}
        />
        Todo el día
      </label>
      <div className="schedule-grid">
        <div className="field">
          <label htmlFor={`${id}-start-date`}>Empieza</label>
          <input
            id={`${id}-start-date`}
            type="date"
            value={value.startDate}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(event) =>
              set({
                startDate: event.target.value,
                // A one-day event is the common case: fill the end with the same day.
                ...(value.endDate === "" || value.endDate < event.target.value
                  ? { endDate: event.target.value }
                  : {}),
              })
            }
          />
        </div>
        {value.allDay ? null : (
          <div className="field">
            <label htmlFor={`${id}-start-time`}>Hora de inicio</label>
            <input
              id={`${id}-start-time`}
              type="time"
              value={value.startTime}
              onChange={(event) => set({ startTime: event.target.value })}
            />
          </div>
        )}
        <div className="field">
          <label htmlFor={`${id}-end-date`}>Termina</label>
          <input
            id={`${id}-end-date`}
            type="date"
            value={value.endDate}
            min={value.startDate || undefined}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(event) => set({ endDate: event.target.value })}
          />
        </div>
        {value.allDay ? null : (
          <div className="field">
            <label htmlFor={`${id}-end-time`}>Hora de fin</label>
            <input
              id={`${id}-end-time`}
              type="time"
              value={value.endTime}
              onChange={(event) => set({ endTime: event.target.value })}
            />
          </div>
        )}
      </div>
      <p
        id={`${id}-error`}
        className={error ? "field-error" : "field-hint"}
        role="status"
        aria-live="polite"
      >
        {error ?? (shown ? `Se mostrará: ${shown}` : "Sin fecha todavía.")}
      </p>
    </fieldset>
  );
}

export interface VenueOption {
  readonly contentId: string;
  readonly title: string;
  readonly published: boolean;
  readonly location: { readonly lat: number; readonly lng: number } | null;
}

/** Where the event happens, among the municipality's destinations (optional). */
export function VenueField({
  value,
  options,
  disabled,
  error,
  onChange,
}: {
  readonly value: string | null;
  readonly options: readonly VenueOption[];
  readonly disabled: boolean;
  readonly error?: string | undefined;
  readonly onChange: (venue: VenueOption | null) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={`${id}-venue`}>Lugar (opcional)</label>
      <span id={`${id}-venue-hint`} className="field-hint">
        Si el evento es en uno de tus destinos, elígelo: su ficha se enlaza desde el evento y su
        ubicación se copia abajo.
      </span>
      <select
        id={`${id}-venue`}
        value={value ?? ""}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-venue-hint${error ? ` ${id}-venue-error` : ""}`}
        onChange={(event) =>
          onChange(options.find((option) => option.contentId === event.target.value) ?? null)
        }
      >
        <option value="">Ningún destino</option>
        {options.map((option) => (
          <option key={option.contentId} value={option.contentId}>
            {option.title}
            {option.published ? "" : " (sin publicar)"}
          </option>
        ))}
      </select>
      {error ? (
        <span id={`${id}-venue-error`} className="field-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}
