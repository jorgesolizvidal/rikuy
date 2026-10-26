"use client";

import type { TourCandidate } from "@rikuy/core";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId } from "react";

import { createTourAction, type CreateTourState } from "./actions";
import { KIND } from "./labels";

const MESSAGES: Partial<Record<CreateTourState["status"], string>> = {
  exists: "Ese destino o evento ya tiene su tour. Lo encuentras en la lista.",
  not_found: "Ese destino o evento ya no existe. Recarga la página.",
  forbidden: "Tu rol no permite crear tours.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  error: "No se pudo crear. Inténtalo de nuevo en unos segundos.",
};

export function NewTourForm({
  org,
  candidates,
}: {
  readonly org: string;
  readonly candidates: readonly TourCandidate[];
}) {
  const router = useRouter();
  const id = useId();
  const [state, action, pending] = useActionState(createTourAction, {
    status: "idle",
  } satisfies CreateTourState);

  useEffect(() => {
    if (state.status === "created") router.push(`/o/${org}/tours/${state.tourId}`);
  }, [state, org, router]);

  const message = MESSAGES[state.status];
  const destinations = candidates.filter((candidate) => candidate.kind === "destination");
  const events = candidates.filter((candidate) => candidate.kind === "event");

  return (
    <form action={action} className="invite-form">
      <input type="hidden" name="org" value={org} />
      <div className="field">
        <label htmlFor={`${id}-content`}>Destino o evento</label>
        <select id={`${id}-content`} name="contentId" required defaultValue="">
          <option value="" disabled>
            Elige uno
          </option>
          {destinations.length > 0 ? (
            <optgroup label="Destinos">
              {destinations.map((candidate) => (
                <option key={candidate.contentId} value={candidate.contentId}>
                  {candidate.title}
                </option>
              ))}
            </optgroup>
          ) : null}
          {events.length > 0 ? (
            <optgroup label="Eventos">
              {events.map((candidate) => (
                <option key={candidate.contentId} value={candidate.contentId}>
                  {candidate.title}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
        <p className="field-hint">
          Solo aparecen los {KIND.destination.label.toLowerCase()}s y eventos próximos que todavía
          no tienen tour.
        </p>
      </div>
      <button type="submit" className="button" disabled={pending}>
        {pending ? "Creando…" : "Crear tour"}
      </button>
      {message ? (
        <p className="field-error" role="alert">
          {message}
        </p>
      ) : null}
    </form>
  );
}
