"use client";

import { TOUR_LIMITS, type TourPublicationIssue } from "@rikuy/core";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import {
  addHotspotAction,
  addSceneAction,
  changeSceneAction,
  discardTourDraftAction,
  publishTourAction,
  removeHotspotAction,
  restoreTourAction,
  updateHotspotAction,
  updateSceneAction,
} from "../actions";
import type { EditorModelOption, EditorTargetOption } from "./hotspot-form";
import { SceneDetail, type EditorScene } from "./scene-detail";

export type { EditorScene } from "./scene-detail";

export interface EditorOption {
  readonly versionId: string;
  readonly previewUrl: string | null;
  readonly size: string | null;
  readonly uploaded: string;
}

export interface EditorHistoryEntry {
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly sealedAt: string;
  readonly scenes: number;
  readonly current: boolean;
}

export interface TourEditorProps {
  readonly org: string;
  readonly tourId: string;
  readonly contentTitle: string;
  readonly editCount: number | null;
  readonly entrySceneId: string | null;
  readonly scenes: readonly EditorScene[];
  readonly options: readonly EditorOption[];
  readonly models: readonly EditorModelOption[];
  readonly targets: readonly EditorTargetOption[];
  readonly canEdit: boolean;
  readonly canPublish: boolean;
  readonly hasDraft: boolean;
  readonly hasPublished: boolean;
  readonly issues: readonly TourPublicationIssue[];
  readonly history: readonly EditorHistoryEntry[];
}

const ISSUES: Record<TourPublicationIssue, string> = {
  no_scenes: "Agrega al menos una escena.",
  no_entry: "Elige la escena de entrada.",
  panorama_missing: "Un panorama no está listo: quítalo o espera a que termine de procesarse.",
  model_poster:
    "Un modelo 3D de un punto no tiene su imagen todavía: ábrelo una vez en «Modelos 3D» para capturarla.",
};

const DATE = new Intl.DateTimeFormat("es-BO", {
  dateStyle: "medium",
  timeStyle: "short",
  hour12: false,
  timeZone: "America/La_Paz",
});

function failureMessage(status: string): string {
  switch (status) {
    case "conflict":
      return "Este tour cambió mientras lo editabas (otra pestaña u otra persona). Se cargó la versión actual: revisa y vuelve a intentarlo.";
    case "duplicate":
      return "Ese panorama ya es una escena de este tour.";
    case "invalid":
      return "No se pudo guardar: algo de lo elegido ya no está disponible o se llegó a un límite.";
    case "rejected":
      return "Revisa los campos marcados.";
    case "forbidden":
      return "Tu rol no permite este cambio.";
    case "not_found":
      return "Ese elemento ya no existe. Recarga la página.";
    case "incomplete":
      return "Al tour le falta algo para publicarse (escenas o escena de entrada).";
    case "media":
      return "Un panorama o una foto no están listos todavía.";
    case "poster":
      return "Un modelo 3D de un punto no tiene su imagen todavía. Ábrelo una vez en «Modelos 3D».";
    case "never_published":
      return "Un tour que nunca se publicó conserva su borrador.";
    case "signed_out":
      return "Tu sesión venció. Inicia sesión de nuevo.";
    default:
      return "No se pudo guardar. Inténtalo de nuevo en unos segundos.";
  }
}

export function TourEditor(props: TourEditorProps) {
  const router = useRouter();
  const id = useId();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [selected, setSelected] = useState<string | null>(
    props.entrySceneId ?? props.scenes[0]?.sceneId ?? null,
  );
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"discard" | string | null>(null);
  const [titles, setTitles] = useState<Record<string, string>>({});

  const scene = props.scenes.find((entry) => entry.sceneId === selected) ?? props.scenes[0] ?? null;
  const target = { tourId: props.tourId, expectedEdit: props.editCount };

  function settle(result: { status: string } | null, success: string) {
    if (result === null) return;
    if (
      result.status === "saved" ||
      result.status === "published" ||
      result.status === "restored" ||
      result.status === "discarded"
    ) {
      setMessage({ text: success, error: false });
      router.refresh();
    } else {
      setMessage({ text: failureMessage(result.status), error: true });
      if (result.status === "conflict") router.refresh();
    }
  }

  function perform<T extends { status: string }>(
    work: () => Promise<T>,
    success: string,
  ): Promise<T | null> {
    return new Promise((resolve) => {
      startTransition(async () => {
        try {
          const result = await work();
          settle(result, success);
          resolve(result);
        } catch {
          setMessage({ text: failureMessage("error"), error: true });
          resolve(null);
        }
      });
    });
  }

  const sceneCount = props.scenes.length;
  // Removing a scene also removes its points and the arrows that led to it.
  const lostPoints = (sceneId: string) =>
    props.scenes.reduce(
      (count, entry) =>
        count +
        (entry.sceneId === sceneId
          ? entry.hotspots.length
          : entry.hotspots.filter((hotspot) => hotspot.targetSceneId === sceneId).length),
      0,
    );

  return (
    <div className="tour-editor">
      <p className="visually-hidden" role="status" aria-live="polite">
        {message && !message.error ? message.text : ""}
      </p>
      {message?.error ? (
        <p className="field-error tour-message" role="alert">
          {message.text}
        </p>
      ) : null}

      <div className="tour-layout">
        <section aria-labelledby={`${id}-scenes`} className="tour-scenes">
          <h2 id={`${id}-scenes`}>Escenas</h2>
          {sceneCount === 0 ? (
            <p className="notice">Este tour todavía no tiene escenas. Agrega un panorama abajo.</p>
          ) : (
            <ol className="tour-scene-list">
              {props.scenes.map((entry, index) => {
                const isEntry = entry.sceneId === props.entrySceneId;
                const isSelected = entry.sceneId === scene?.sceneId;
                return (
                  <li key={entry.sceneId} className="tour-scene-item" data-selected={isSelected}>
                    <button
                      type="button"
                      className="tour-scene-pick"
                      aria-pressed={isSelected}
                      onClick={() => setSelected(entry.sceneId)}
                    >
                      <span className="panorama-thumb" data-empty={entry.previewUrl === null}>
                        {entry.previewUrl ? (
                          // Short-lived signed URL: next/image would cache it past expiry.
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={entry.previewUrl}
                            alt=""
                            width={256}
                            height={128}
                            loading="lazy"
                          />
                        ) : null}
                      </span>
                      <span className="tour-scene-name">
                        <span className="cell-detail">Escena {index + 1}</span>
                        {entry.title}
                        {isEntry ? (
                          <span className="status-pill" data-status="entry">
                            Escena de entrada
                          </span>
                        ) : null}
                      </span>
                    </button>
                    {props.canEdit ? (
                      <div className="row-actions">
                        <button
                          type="button"
                          className="button button-quiet"
                          disabled={pending || index === 0}
                          aria-label={`Subir «${entry.title}»`}
                          onClick={() =>
                            void perform(
                              () =>
                                changeSceneAction(
                                  props.org,
                                  { ...target, sceneId: entry.sceneId },
                                  { kind: "move", position: index - 1 },
                                ),
                              `«${entry.title}» subió al lugar ${index}.`,
                            )
                          }
                        >
                          Subir
                        </button>
                        <button
                          type="button"
                          className="button button-quiet"
                          disabled={pending || index === sceneCount - 1}
                          aria-label={`Bajar «${entry.title}»`}
                          onClick={() =>
                            void perform(
                              () =>
                                changeSceneAction(
                                  props.org,
                                  { ...target, sceneId: entry.sceneId },
                                  { kind: "move", position: index + 1 },
                                ),
                              `«${entry.title}» bajó al lugar ${index + 2}.`,
                            )
                          }
                        >
                          Bajar
                        </button>
                        {isEntry ? null : (
                          <button
                            type="button"
                            className="button button-quiet"
                            disabled={pending}
                            aria-label={`Usar «${entry.title}» como escena de entrada`}
                            onClick={() =>
                              void perform(
                                () =>
                                  changeSceneAction(
                                    props.org,
                                    { ...target, sceneId: entry.sceneId },
                                    { kind: "entry" },
                                  ),
                                `«${entry.title}» es ahora la escena de entrada.`,
                              )
                            }
                          >
                            Usar como entrada
                          </button>
                        )}
                        {removing === entry.sceneId ? (
                          <>
                            <button
                              type="button"
                              className="button button-danger"
                              disabled={pending}
                              onClick={() => {
                                setRemoving(null);
                                void perform(
                                  () =>
                                    changeSceneAction(
                                      props.org,
                                      { ...target, sceneId: entry.sceneId },
                                      { kind: "remove" },
                                    ),
                                  isEntry && sceneCount > 1
                                    ? `Se quitó «${entry.title}». La escena de entrada ahora es «${props.scenes.find((other) => other.sceneId !== entry.sceneId)?.title}».`
                                    : `Se quitó «${entry.title}».`,
                                );
                              }}
                            >
                              Confirmar: quitar «{entry.title}»
                              {lostPoints(entry.sceneId) > 0
                                ? ` y ${lostPoints(entry.sceneId) === 1 ? "1 punto" : `${lostPoints(entry.sceneId)} puntos`}`
                                : ""}
                            </button>
                            <button
                              type="button"
                              className="button button-quiet"
                              onClick={() => setRemoving(null)}
                            >
                              Cancelar
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="button button-quiet"
                            disabled={pending}
                            aria-label={`Quitar «${entry.title}» del tour`}
                            onClick={() => setRemoving(entry.sceneId)}
                          >
                            Quitar
                          </button>
                        )}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        {scene ? (
          <SceneDetail
            key={`${scene.sceneId}:${scene.title}:${scene.description}`}
            org={props.org}
            scene={scene}
            scenes={props.scenes.map((entry) => ({ sceneId: entry.sceneId, title: entry.title }))}
            models={props.models}
            targets={props.targets}
            canEdit={props.canEdit}
            pending={pending}
            onAddHotspot={(hotspot, title) =>
              perform(
                () => addHotspotAction(props.org, { ...target, sceneId: scene.sceneId }, hotspot),
                `Se agregó el punto «${title}».`,
              )
            }
            onUpdateHotspot={(hotspot, changes, success) =>
              perform(
                () =>
                  updateHotspotAction(
                    props.org,
                    { ...target, hotspotId: hotspot.hotspotId, kind: hotspot.kind },
                    changes,
                  ),
                success,
              )
            }
            onRemoveHotspot={(hotspot) =>
              perform(
                () => removeHotspotAction(props.org, { ...target, hotspotId: hotspot.hotspotId }),
                `Se quitó el punto «${hotspot.title}».`,
              )
            }
            onSave={(changes) =>
              perform(
                () => updateSceneAction(props.org, { ...target, sceneId: scene.sceneId }, changes),
                "initialView" in changes
                  ? "Se guardó la vista inicial."
                  : "Se guardaron el nombre y la descripción.",
              )
            }
          />
        ) : null}
      </div>

      {props.canEdit ? (
        <section aria-labelledby={`${id}-add`} className="members-invite">
          <h2 id={`${id}-add`}>Agregar escenas</h2>
          {props.options.length === 0 ? (
            <p className="field-hint">
              No hay más panoramas listos. Sube otros en{" "}
              <a href={`/o/${props.org}/panoramas`}>Panoramas 360°</a>.
            </p>
          ) : (
            <ul className="tour-options" aria-label="Panoramas listos que no están en este tour">
              {props.options.map((option, index) => {
                const title = titles[option.versionId] ?? `Escena ${sceneCount + index + 1}`;
                return (
                  <li key={option.versionId} className="tour-option">
                    <span className="panorama-thumb" data-empty={option.previewUrl === null}>
                      {option.previewUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={option.previewUrl}
                          alt={`Panorama subido el ${option.uploaded}`}
                          width={256}
                          height={128}
                          loading="lazy"
                        />
                      ) : null}
                    </span>
                    <form
                      className="tour-option-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void perform(
                          () =>
                            addSceneAction(props.org, target, {
                              panoramaVersionId: option.versionId,
                              title,
                            }),
                          `Se agregó «${title.trim()}» al final del tour.`,
                        );
                      }}
                    >
                      <div className="field">
                        <label htmlFor={`${id}-${option.versionId}`}>Nombre de la escena</label>
                        <input
                          id={`${id}-${option.versionId}`}
                          value={title}
                          maxLength={TOUR_LIMITS.sceneTitle}
                          required
                          onChange={(event) =>
                            setTitles({ ...titles, [option.versionId]: event.target.value })
                          }
                        />
                        <p className="field-hint">
                          {option.size ? `${option.size} · ` : ""}Subido el {option.uploaded}
                        </p>
                      </div>
                      <button
                        type="submit"
                        className="button"
                        disabled={pending || title.trim() === ""}
                      >
                        Agregar al tour
                      </button>
                    </form>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}

      <section aria-labelledby={`${id}-publish`} className="members-invite">
        <h2 id={`${id}-publish`}>Publicación</h2>
        {props.hasDraft ? (
          props.issues.length > 0 ? (
            <ul className="tour-issues">
              {props.issues.map((issue) => (
                <li key={issue}>{ISSUES[issue]}</li>
              ))}
            </ul>
          ) : (
            <p className="field-hint">El borrador está listo para publicarse.</p>
          )
        ) : (
          <p className="field-hint">
            No hay cambios sin publicar. Cualquier cambio abre un borrador nuevo.
          </p>
        )}
        <div className="row-actions">
          {props.canPublish && props.hasDraft ? (
            <button
              type="button"
              className="button"
              disabled={pending || props.issues.length > 0}
              onClick={() =>
                void perform(() => publishTourAction(props.org, target), "Se publicó el tour.")
              }
            >
              Publicar
            </button>
          ) : null}
          {props.canEdit && props.hasDraft && props.hasPublished ? (
            confirm === "discard" ? (
              <>
                <button
                  type="button"
                  className="button button-danger"
                  disabled={pending}
                  onClick={() => {
                    setConfirm(null);
                    void perform(
                      () => discardTourDraftAction(props.org, target),
                      "Se descartaron los cambios.",
                    );
                  }}
                >
                  Confirmar: descartar los cambios
                </button>
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={() => setConfirm(null)}
                >
                  Cancelar
                </button>
              </>
            ) : (
              <button
                type="button"
                className="button button-quiet"
                disabled={pending}
                onClick={() => setConfirm("discard")}
              >
                Descartar cambios
              </button>
            )
          ) : null}
        </div>
        {props.hasDraft && !props.canPublish && props.canEdit ? (
          <p className="field-hint">Un propietario o administrador del municipio lo publica.</p>
        ) : null}
      </section>

      {props.history.length > 0 ? (
        <section aria-labelledby={`${id}-history`} className="members-invite">
          <h2 id={`${id}-history`}>Versiones publicadas</h2>
          <ul className="revision-list">
            {props.history.map((entry) => (
              <li key={entry.revisionId}>
                <span>
                  Versión {entry.revisionNo} ·{" "}
                  {entry.scenes === 1 ? "1 escena" : `${entry.scenes} escenas`} ·{" "}
                  {DATE.format(new Date(entry.sealedAt))}
                  {entry.current ? (
                    <span className="status-pill" data-status="published">
                      Publicada
                    </span>
                  ) : null}
                </span>
                {props.canPublish && !entry.current ? (
                  confirm === entry.revisionId ? (
                    <span className="row-actions">
                      <button
                        type="button"
                        className="button button-danger"
                        disabled={pending}
                        onClick={() => {
                          setConfirm(null);
                          void perform(
                            () =>
                              restoreTourAction(props.org, {
                                tourId: props.tourId,
                                revisionId: entry.revisionId,
                              }),
                            `Se publicó otra vez la versión ${entry.revisionNo}.`,
                          );
                        }}
                      >
                        Confirmar: publicar la versión {entry.revisionNo}
                      </button>
                      <button
                        type="button"
                        className="button button-quiet"
                        onClick={() => setConfirm(null)}
                      >
                        Cancelar
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="button button-quiet"
                      onClick={() => setConfirm(entry.revisionId)}
                    >
                      Volver a esta versión
                    </button>
                  )
                ) : null}
              </li>
            ))}
          </ul>
          <p className="field-hint">
            Volver a una versión publica de nuevo sus escenas, su orden y su escena de entrada; el
            borrador, si hay uno, no cambia.
          </p>
        </section>
      ) : null}
    </div>
  );
}
