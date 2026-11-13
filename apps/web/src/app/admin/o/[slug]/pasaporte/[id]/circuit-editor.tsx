"use client";

import "../passport.css";

import type { PassportCircuit, PassportDestinationOption } from "@rikuy/core";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import {
  deleteCircuitAction,
  publishCircuitAction,
  saveCircuitAction,
  withdrawCircuitAction,
  type CircuitWriteState,
  type DeleteCircuitState,
} from "../actions";

const MESSAGES: Partial<
  Record<CircuitWriteState["status"] | DeleteCircuitState["status"], string>
> = {
  stale: "Alguien cambió el circuito mientras tanto. Recarga la página para ver la última versión.",
  incomplete: "Hacen falta al menos dos destinos publicados.",
  invalid: "Revisa los campos marcados.",
  not_found: "El circuito ya no existe. Vuelve a la lista.",
  published: "Un circuito que ya se publicó no se borra: retíralo del portal.",
  forbidden: "Tu rol no permite este cambio.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  error: "No se pudo guardar. Inténtalo de nuevo en unos segundos.",
};

/**
 * A circuit: name, description, prize and stops in their suggested order (C2 · Paso 1,
 * ADR-056). Saving keeps everything; publishing and withdrawing apply at once.
 */
export function CircuitEditor({
  org,
  circuit,
  destinations,
  canChange,
  canPublish,
  issues,
}: {
  readonly org: string;
  readonly circuit: PassportCircuit;
  readonly destinations: readonly PassportDestinationOption[];
  readonly canChange: boolean;
  readonly canPublish: boolean;
  readonly issues: readonly string[];
}) {
  const router = useRouter();
  const id = useId();
  const [name, setName] = useState(circuit.name);
  const [summary, setSummary] = useState(circuit.summary);
  const [reward, setReward] = useState(circuit.reward);
  const [stops, setStops] = useState(() => circuit.stops.map((stop) => stop.contentId));
  const [adding, setAdding] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [pending, startTransition] = useTransition();
  const byId = new Map(destinations.map((destination) => [destination.contentId, destination]));
  for (const stop of circuit.stops) {
    if (!byId.has(stop.contentId)) {
      byId.set(stop.contentId, {
        contentId: stop.contentId,
        title: stop.title,
        published: stop.published,
      });
    }
  }
  const available = destinations.filter((destination) => !stops.includes(destination.contentId));
  const changed =
    name !== circuit.name ||
    summary !== circuit.summary ||
    reward !== circuit.reward ||
    stops.join() !== circuit.stops.map((stop) => stop.contentId).join();
  const published = circuit.status === "published";

  const move = (index: number, by: -1 | 1) =>
    setStops((current) => {
      const next = [...current];
      const [item] = next.splice(index, 1);
      if (item) next.splice(index + by, 0, item);
      return next;
    });

  const after = (result: CircuitWriteState, done: string) => {
    setErrors(result.status === "invalid" ? (result.errors ?? {}) : {});
    setMessage(result.status === "saved" ? done : (MESSAGES[result.status] ?? null));
    if (result.status === "saved") router.refresh();
  };

  const save = () =>
    startTransition(async () => {
      const result = await saveCircuitAction(org, {
        circuitId: circuit.id,
        editNo: circuit.editNo,
        name,
        summary,
        reward,
        stops,
        published,
      });
      after(result, published ? "Se guardó. Los visitantes ya ven los cambios." : "Se guardó.");
    });

  const publish = () =>
    startTransition(async () => {
      after(
        await publishCircuitAction(org, circuit.id, circuit.editNo),
        "Se publicó: el circuito ya está en el portal.",
      );
    });

  const withdraw = () =>
    startTransition(async () => {
      after(
        await withdrawCircuitAction(org, circuit.id, circuit.editNo),
        "Se retiró del portal. Puedes volver a publicarlo cuando quieras.",
      );
    });

  const remove = () =>
    startTransition(async () => {
      const result = await deleteCircuitAction(org, circuit.id, circuit.editNo);
      if (result.status === "deleted") {
        router.push(`/o/${org}/pasaporte`);
        return;
      }
      setConfirmDelete(false);
      setMessage(MESSAGES[result.status] ?? null);
    });

  return (
    <div className="circuit-editor">
      <section aria-labelledby={`${id}-datos`} className="members-invite">
        <h2 id={`${id}-datos`}>El circuito</h2>
        <div className="field">
          <label htmlFor={`${id}-name`}>Nombre</label>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={80}
            disabled={!canChange || pending}
            onChange={(event) => setName(event.target.value)}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={errors.name ? `${id}-name-error` : undefined}
          />
          {errors.name ? (
            <p id={`${id}-name-error`} className="field-error">
              {errors.name}
            </p>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor={`${id}-summary`}>Descripción corta</label>
          <input
            id={`${id}-summary`}
            value={summary}
            maxLength={300}
            disabled={!canChange || pending}
            onChange={(event) => setSummary(event.target.value)}
            aria-describedby={`${id}-summary-hint`}
          />
          <p id={`${id}-summary-hint`} className={errors.summary ? "field-error" : "field-hint"}>
            {errors.summary ?? "Una línea: qué se recorre y cuánto lleva, por ejemplo."}
          </p>
        </div>
        <div className="field">
          <label htmlFor={`${id}-reward`}>Premio al completarlo</label>
          <input
            id={`${id}-reward`}
            value={reward}
            maxLength={200}
            disabled={!canChange || pending}
            onChange={(event) => setReward(event.target.value)}
            aria-describedby={`${id}-reward-hint`}
          />
          <p id={`${id}-reward-hint`} className={errors.reward ? "field-error" : "field-hint"}>
            {errors.reward ??
              "Qué recibe el visitante y dónde, por ejemplo «Una postal en la oficina de turismo». El canje con código llega más adelante."}
          </p>
        </div>
      </section>

      <section aria-labelledby={`${id}-paradas`} className="members-invite">
        <h2 id={`${id}-paradas`}>Paradas</h2>
        <p className="field-hint">
          Destinos del municipio, en el orden sugerido; el visitante puede recorrerlos en cualquier
          orden. En el portal solo se ven los que están publicados.
        </p>
        {stops.length === 0 ? (
          <p className="notice">Todavía no tiene paradas.</p>
        ) : (
          <ol className="circuit-stops">
            {stops.map((contentId, index) => {
              const destination = byId.get(contentId);
              const title = destination?.title ?? "(destino)";
              return (
                <li key={contentId}>
                  <span className="circuit-stop-place" aria-hidden="true">
                    {index + 1}
                  </span>
                  <span className="circuit-stop-text">
                    <strong>{title}</strong>
                    <span className="cell-detail">
                      {destination?.published ? "Publicado" : "Sin publicar: no se ve en el portal"}
                    </span>
                  </span>
                  {canChange ? (
                    <span className="circuit-stop-actions">
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
                        disabled={index === stops.length - 1 || pending}
                        onClick={() => move(index, 1)}
                      >
                        Bajar<span className="visually-hidden"> «{title}»</span>
                      </button>
                      <button
                        type="button"
                        className="button button-quiet"
                        disabled={pending}
                        onClick={() =>
                          setStops((current) => current.filter((stop) => stop !== contentId))
                        }
                      >
                        Quitar<span className="visually-hidden"> «{title}»</span>
                      </button>
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
        {errors.stops ? <p className="field-error">{errors.stops}</p> : null}
        {canChange && available.length > 0 ? (
          <div className="circuit-add">
            <div className="field">
              <label htmlFor={`${id}-add`}>Agregar un destino</label>
              <select
                id={`${id}-add`}
                value={adding}
                disabled={pending}
                onChange={(event) => setAdding(event.target.value)}
              >
                <option value="">Elige uno</option>
                {available.map((destination) => (
                  <option key={destination.contentId} value={destination.contentId}>
                    {destination.title}
                    {destination.published ? "" : " (sin publicar)"}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="button button-quiet"
              disabled={!adding || pending}
              onClick={() => {
                setStops((current) => [...current, adding]);
                setAdding("");
              }}
            >
              Agregar
            </button>
          </div>
        ) : null}
      </section>

      {canChange ? (
        <div className="circuit-save">
          <button type="button" className="button" disabled={!changed || pending} onClick={save}>
            {pending ? "Guardando…" : published ? "Guardar (se ve al momento)" : "Guardar"}
          </button>
        </div>
      ) : null}

      {canPublish ? (
        <section aria-labelledby={`${id}-publicar`} className="members-invite">
          <h2 id={`${id}-publicar`}>{published ? "En el portal" : "Publicar"}</h2>
          {published ? (
            <>
              <p className="field-hint">
                El circuito está en el portal. Al retirarlo, deja de verse y vuelve a ser un
                borrador.
              </p>
              <button
                type="button"
                className="button button-quiet"
                disabled={pending}
                onClick={withdraw}
              >
                Retirar del portal
              </button>
            </>
          ) : (
            <>
              {issues.length > 0 ? (
                <ul className="field-hint">
                  {issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              ) : (
                <p className="field-hint">Al publicarlo, el circuito aparece en el portal.</p>
              )}
              {changed ? <p className="field-hint">Guarda los cambios antes de publicar.</p> : null}
              <button
                type="button"
                className="button"
                disabled={pending || changed || issues.length > 0}
                onClick={publish}
              >
                Publicar el circuito
              </button>
            </>
          )}
          {circuit.publishedAt === null ? (
            <div className="circuit-delete">
              {confirmDelete ? (
                <>
                  <p>¿Borrar el circuito «{circuit.name}»? No se puede deshacer.</p>
                  <button
                    key="confirm"
                    type="button"
                    className="button button-danger"
                    disabled={pending}
                    onClick={remove}
                  >
                    Sí, borrar
                  </button>{" "}
                  <button
                    key="cancel"
                    type="button"
                    className="button button-quiet"
                    disabled={pending}
                    onClick={() => setConfirmDelete(false)}
                  >
                    Cancelar
                  </button>
                </>
              ) : (
                <button
                  key="ask"
                  type="button"
                  className="button button-quiet"
                  disabled={pending}
                  onClick={() => setConfirmDelete(true)}
                >
                  Borrar el circuito
                </button>
              )}
            </div>
          ) : null}
        </section>
      ) : null}

      <p className="field-hint" role="status" aria-live="polite">
        {message}
      </p>
    </div>
  );
}
