"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { deleteTourAction, moveTourAction } from "../actions";

/**
 * «Borrar o mover el tour» (C0 · Paso 3, ADR-049), for owners and admins. Both ask first and
 * say what changes: deleting is final; a moved tour keeps everything and its old page leads to
 * the new one. "Go to another tour" points of other tours that lead here are hidden from
 * visitors, and the confirmation names those tours.
 */

export interface TourLinkFromDto {
  readonly tourId: string;
  readonly contentTitle: string;
  readonly draft: boolean;
  readonly published: boolean;
}

export interface TourDestinationDto {
  readonly contentId: string;
  readonly kind: "destination" | "event";
  readonly title: string;
}

const MOVE_FAILURES: Record<string, string> = {
  same: "El tour ya está en ese lugar.",
  taken: "Ese lugar ya tiene un tour. Recarga la página.",
  self_link:
    "Un punto «Ir a otro recorrido» de este tour lleva a ese lugar. Quítalo (y publica el tour, si ese punto está publicado) antes de pasarlo.",
  forbidden: "Solo propietarios y administradores pueden pasar un tour a otro lugar.",
  not_found: "Ese lugar o el tour ya no existe. Recarga la página.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  error: "No se pudo pasar el tour. Inténtalo de nuevo.",
};

const DELETE_FAILURES: Record<string, string> = {
  forbidden: "Solo propietarios y administradores pueden borrar un tour.",
  not_found: "El tour ya no existe. Recarga la página.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  error: "No se pudo borrar el tour. Inténtalo de nuevo.",
};

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many.replace("{n}", String(count));
}

function LinkedFrom({ tours }: { readonly tours: readonly TourLinkFromDto[] }) {
  if (tours.length === 0) return null;
  return (
    <div className="notice" role="note">
      <p>
        {plural(
          tours.length,
          "Otro tour tiene un punto «Ir a otro recorrido» que lleva aquí:",
          "{n} tours tienen un punto «Ir a otro recorrido» que lleva aquí:",
        )}
      </p>
      <ul>
        {tours.map((tour) => (
          <li key={tour.tourId}>
            Tour de {tour.contentTitle}
            {tour.published ? " · publicado" : ""}
            {tour.draft ? " · en su borrador" : ""}
            {!tour.published && !tour.draft ? " · solo en una versión anterior" : ""}
          </li>
        ))}
      </ul>
      <p>Los visitantes dejarán de ver esos puntos. Puedes quitarlos o cambiarlos en cada tour.</p>
    </div>
  );
}

export function TourRemoval({
  org,
  tourId,
  contentTitle,
  revisions,
  published,
  inGeneralTour,
  startsGeneralTour,
  linkedFrom,
  destinations,
}: {
  readonly org: string;
  readonly tourId: string;
  readonly contentTitle: string;
  readonly revisions: number;
  readonly published: boolean;
  readonly inGeneralTour: boolean;
  readonly startsGeneralTour: boolean;
  readonly linkedFrom: readonly TourLinkFromDto[];
  readonly destinations: readonly TourDestinationDto[];
}) {
  const router = useRouter();
  const selectId = useId();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState<"move" | "delete" | null>(null);
  const [destination, setDestination] = useState("");
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const chosen = destinations.find((option) => option.contentId === destination) ?? null;
  const places = {
    destination: destinations.filter((option) => option.kind === "destination"),
    event: destinations.filter((option) => option.kind === "event"),
  };

  function move() {
    if (!chosen) return;
    startTransition(async () => {
      const result = await moveTourAction(org, { tourId, contentId: chosen.contentId });
      setConfirming(null);
      if (result.status === "moved") {
        setDestination("");
        setMessage({
          text: `El tour pasó a «${chosen.title}». Su dirección anterior lleva a la nueva.`,
          failed: false,
        });
        router.refresh();
      } else {
        setMessage({ text: MOVE_FAILURES[result.status] ?? MOVE_FAILURES.error!, failed: true });
      }
    });
  }

  function remove() {
    startTransition(async () => {
      const result = await deleteTourAction(org, tourId);
      if (result.status === "deleted") {
        router.push(`/o/${org}/tours`);
        router.refresh();
      } else {
        setConfirming(null);
        setMessage({
          text: DELETE_FAILURES[result.status] ?? DELETE_FAILURES.error!,
          failed: true,
        });
      }
    });
  }

  const history =
    revisions === 0
      ? "Todavía no se publicó."
      : plural(revisions, "Tiene 1 versión publicada.", "Tiene {n} versiones publicadas.");
  const general = startsGeneralTour
    ? " Está en el recorrido general, y el recorrido empieza aquí."
    : inGeneralTour
      ? " Está en el recorrido general."
      : "";

  return (
    <section aria-labelledby="borrar-mover" className="tour-removal">
      <h2 id="borrar-mover">Borrar o mover el tour</h2>
      <p className="field-hint">
        {history}
        {general}
      </p>

      <div className="tour-removal-move">
        <h3>Pasar a otro destino o evento</h3>
        <p className="field-hint">
          El tour pasa entero: su borrador, sus versiones y su lugar en el recorrido general. Los
          enlaces y códigos QR del tour que ya circulan llevan a su lugar nuevo.
        </p>
        {destinations.length === 0 ? (
          <p className="field-hint">
            Todos los destinos y eventos próximos ya tienen un tour: no hay a dónde pasarlo.
          </p>
        ) : (
          <div className="inline-form">
            <label htmlFor={selectId}>Pasar a</label>
            <select
              id={selectId}
              value={destination}
              disabled={pending}
              onChange={(event) => {
                setDestination(event.target.value);
                setConfirming(null);
                setMessage(null);
              }}
            >
              <option value="">Elige un lugar sin tour</option>
              {places.destination.length > 0 ? (
                <optgroup label="Destinos">
                  {places.destination.map((option) => (
                    <option key={option.contentId} value={option.contentId}>
                      {option.title}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {places.event.length > 0 ? (
                <optgroup label="Eventos">
                  {places.event.map((option) => (
                    <option key={option.contentId} value={option.contentId}>
                      {option.title}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
            {confirming === "move" ? null : (
              <button
                key="ask-move"
                type="button"
                className="button button-quiet"
                disabled={!chosen || pending}
                onClick={() => {
                  setMessage(null);
                  setConfirming("move");
                }}
              >
                Pasar el tour…
              </button>
            )}
          </div>
        )}
        {confirming === "move" && chosen ? (
          <div className="confirm-box">
            <p>
              ¿Pasar el tour de «{contentTitle}» a «{chosen.title}»? «{contentTitle}» se queda sin
              tour.
            </p>
            <LinkedFrom tours={linkedFrom} />
            <div className="inline-form">
              <button
                key="confirm-move"
                type="button"
                className="button"
                disabled={pending}
                onClick={move}
              >
                {pending ? "Pasando…" : "Sí, pasar el tour"}
              </button>
              <button
                key="cancel-move"
                type="button"
                className="button button-quiet"
                disabled={pending}
                onClick={() => setConfirming(null)}
              >
                Cancelar
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="tour-removal-delete">
        <h3>Borrar el tour</h3>
        {confirming === "delete" ? (
          <div className="confirm-box">
            <p>
              ¿Borrar el tour de «{contentTitle}»? Se borran sus escenas, sus puntos y{" "}
              {revisions === 0
                ? "su borrador"
                : plural(revisions, "su versión publicada", "sus {n} versiones publicadas")}
              ; {published ? "sale del portal" : "no estaba en el portal"}
              {inGeneralTour ? " y del recorrido general" : ""}. Sus panoramas y modelos 3D quedan,
              y se pueden borrar después. No se puede deshacer.
            </p>
            <LinkedFrom tours={linkedFrom} />
            <div className="inline-form">
              <button
                key="confirm-delete"
                type="button"
                className="button button-danger"
                disabled={pending}
                onClick={remove}
              >
                {pending ? "Borrando…" : "Sí, borrar el tour"}
              </button>
              <button
                key="cancel-delete"
                type="button"
                className="button button-quiet"
                disabled={pending}
                onClick={() => setConfirming(null)}
              >
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <button
            key="ask-delete"
            type="button"
            className="button button-quiet"
            disabled={pending}
            onClick={() => {
              setMessage(null);
              setConfirming("delete");
            }}
          >
            Borrar el tour…
          </button>
        )}
      </div>

      {message ? (
        <p className={message.failed ? "field-error" : "field-hint"} role="status">
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
