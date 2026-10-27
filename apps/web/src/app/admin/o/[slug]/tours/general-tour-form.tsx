"use client";

import type { GeneralTourEntry } from "@rikuy/core";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { saveGeneralTourAction, type SaveGeneralTourState } from "./actions";
import { KIND } from "./labels";

/**
 * The general tour's order and the tour it starts with (P4 · Paso 5). Every tour with a
 * published version is listed, with whether visitors see it now; the order and the start are
 * saved together and apply at once. Only owners and administrators change them.
 */
const MESSAGES: Partial<Record<SaveGeneralTourState["status"], string>> = {
  saved: "Se guardó el orden. El recorrido general ya lo usa.",
  conflict: "Alguien guardó otro orden mientras tanto. Si guardas de nuevo, el tuyo lo reemplaza.",
  invalid: "Algún tour ya no está publicado. Recarga la página.",
  forbidden: "Solo propietarios y administradores cambian el recorrido general.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  error: "No se pudo guardar. Inténtalo de nuevo en unos segundos.",
};

function why(entry: GeneralTourEntry): string {
  if (entry.visible) return "Se ve en el recorrido";
  if (entry.ended) return "No se ve: el evento ya terminó";
  if (!entry.contentPublished) return "No se ve: el destino o evento no está publicado";
  return "No se ve todavía";
}

export function GeneralTourForm({
  org,
  editCount,
  startTourId,
  tours,
  canEdit,
}: {
  readonly org: string;
  readonly editCount: number;
  readonly startTourId: string | null;
  readonly tours: readonly GeneralTourEntry[];
  readonly canEdit: boolean;
}) {
  const router = useRouter();
  const id = useId();
  const [order, setOrder] = useState(() => tours.map((tour) => tour.tourId));
  const [start, setStart] = useState<string | null>(startTourId);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const byId = new Map(tours.map((tour) => [tour.tourId, tour]));
  const original = tours.map((tour) => tour.tourId);
  const changed = order.join() !== original.join() || start !== startTourId;
  // The tour visitors start with: the chosen one if they see it, else the first visible.
  const firstVisible = order.find((tourId) => byId.get(tourId)?.visible);
  const startsWith = start && byId.get(start)?.visible ? start : firstVisible;

  const move = (index: number, by: -1 | 1) =>
    setOrder((current) => {
      const next = [...current];
      const [item] = next.splice(index, 1);
      if (item) next.splice(index + by, 0, item);
      return next;
    });

  const save = () =>
    startTransition(async () => {
      const result = await saveGeneralTourAction(org, {
        expectedEdit: editCount,
        order,
        startTourId: start,
      });
      setMessage(MESSAGES[result.status] ?? null);
      if (result.status === "saved" || result.status === "conflict") router.refresh();
    });

  return (
    <div className="general-tour">
      <ol className="general-tour-list">
        {order.map((tourId, index) => {
          const tour = byId.get(tourId);
          if (!tour) return null;
          const title = tour.title ?? "(sin publicar)";
          return (
            <li key={tourId} data-visible={tour.visible}>
              <span className="general-tour-place" aria-hidden="true">
                {index + 1}
              </span>
              <span className="general-tour-text">
                <strong>{title}</strong>
                <span className="cell-detail">
                  {KIND[tour.kind].label} · {why(tour)}
                  {tourId === startsWith ? " · el recorrido empieza aquí" : ""}
                </span>
              </span>
              {canEdit ? (
                <span className="general-tour-actions">
                  <label className="general-tour-start">
                    <input
                      type="radio"
                      name={`${id}-start`}
                      checked={start === tourId}
                      onChange={() => setStart(tourId)}
                    />
                    Empezar aquí
                  </label>
                  <button
                    type="button"
                    className="button button-quiet"
                    disabled={index === 0 || pending}
                    onClick={() => move(index, -1)}
                  >
                    Subir<span className="visually-hidden"> «{title}»</span>
                  </button>
                  <button
                    type="button"
                    className="button button-quiet"
                    disabled={index === order.length - 1 || pending}
                    onClick={() => move(index, 1)}
                  >
                    Bajar<span className="visually-hidden"> «{title}»</span>
                  </button>
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      {canEdit ? (
        <div className="general-tour-save">
          <button type="button" className="button" disabled={!changed || pending} onClick={save}>
            {pending ? "Guardando…" : "Guardar el orden"}
          </button>
          {start ? (
            <button
              type="button"
              className="button button-quiet"
              disabled={pending}
              onClick={() => setStart(null)}
            >
              Empezar por el primero
            </button>
          ) : null}
        </div>
      ) : (
        <p className="field-hint">Tu rol puede ver el orden, pero no cambiarlo.</p>
      )}
      <p className="field-hint" role="status" aria-live="polite">
        {message}
      </p>
    </div>
  );
}
