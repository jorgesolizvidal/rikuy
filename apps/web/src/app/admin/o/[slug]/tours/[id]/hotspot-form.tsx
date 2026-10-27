"use client";

import { TOUR_LIMITS, type HotspotIssue, type HotspotKind } from "@rikuy/core";
import { useId, useState } from "react";

import { hotspotKindLabel } from "@/components/panorama-viewer/hotspot-markers";

import { GalleryField, type EditorImage } from "../../destinos/[id]/image-fields";
import type { HotspotEditState } from "../actions";

/** A point as the editor knows it (serializable, from the server page). */
export interface EditorHotspot {
  readonly hotspotId: string;
  readonly kind: HotspotKind;
  readonly title: string;
  readonly position: { readonly yaw: number; readonly pitch: number };
  /** Info: the text; model: its description. In the writing format of destinations. */
  readonly body: string;
  readonly gallery: readonly EditorImage[];
  readonly targetSceneId: string | null;
  readonly model: { readonly versionId: string; readonly posterUrl: string | null } | null;
  readonly target: {
    readonly contentId: string;
    readonly kind: "destination" | "event";
    readonly title: string;
    readonly tourPublished: boolean;
  } | null;
}

export interface EditorModelOption {
  readonly versionId: string;
  readonly posterUrl: string | null;
  readonly hasPoster: boolean;
  readonly label: string;
}

export interface EditorTargetOption {
  readonly contentId: string;
  readonly kind: "destination" | "event";
  readonly title: string;
  readonly tourPublished: boolean;
}

export interface SceneOption {
  readonly sceneId: string;
  readonly title: string;
}

const KIND_HINT: Record<HotspotKind, string> = {
  info: "Un texto y, si quieres, fotos: lo que el visitante lee al tocar el punto.",
  scene: "Una flecha que lleva a otra escena de este mismo tour.",
  model: "Muestra la imagen de un modelo 3D; el visitante puede abrirlo y girarlo.",
  tour: "Lleva al tour de otro destino o evento del municipio, sin salir del recorrido.",
};

function issueText(issue: HotspotIssue): string {
  switch (issue.field) {
    case "title":
      return issue.code === "required"
        ? "Escribe el nombre del punto."
        : `El nombre va en una línea, hasta ${TOUR_LIMITS.hotspotTitle} caracteres.`;
    case "body":
      return issue.code === "link_not_https"
        ? `El enlace de la línea ${issue.line ?? "?"} debe empezar con https://.`
        : "El texto es demasiado largo.";
    case "gallery":
      return issue.code === "alt_required"
        ? `Describe la foto ${(issue.index ?? 0) + 1} para quien no puede verla.`
        : `Hasta ${TOUR_LIMITS.hotspotPhotos} fotos, cada una con su descripción.`;
    case "target":
      return "Elige a dónde lleva este punto.";
    case "position":
      return "Vuelve a elegir el lugar del punto en el panorama.";
    case "kind":
      return "Ese tipo de punto no existe.";
  }
}

const REASONS: Record<string, string> = {
  target: "Elige a dónde lleva este punto (de este municipio y distinto de esta escena).",
  model: "Ese modelo 3D ya no está listo. Elige otro.",
  gallery: "Una foto ya no está disponible. Quítala y vuelve a subirla.",
  body: "Revisa el texto.",
  title: "Revisa el nombre.",
  position: "Vuelve a elegir el lugar del punto.",
  limit: `Una escena tiene como máximo ${TOUR_LIMITS.hotspotsPerScene} puntos.`,
};

/** The fields to send: everything for a new point, only what changed for an edit (RC-01). */
function fieldsOf(
  kind: HotspotKind,
  values: {
    title: string;
    body: string;
    gallery: readonly EditorImage[];
    targetSceneId: string;
    modelVersionId: string;
    targetContentId: string;
  },
  initial: EditorHotspot | null,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const gallery = values.gallery.map(({ assetId, version, alt }) => ({ assetId, version, alt }));
  const initialGallery = initial?.gallery.map(({ assetId, version, alt }) => ({
    assetId,
    version,
    alt,
  }));
  if (!initial || values.title.trim() !== initial.title) fields.title = values.title;
  if (kind === "info") {
    if (!initial || values.body !== initial.body) fields.body = values.body;
    if (!initial || JSON.stringify(gallery) !== JSON.stringify(initialGallery))
      fields.gallery = gallery;
  }
  if (kind === "scene" && (!initial || values.targetSceneId !== initial.targetSceneId)) {
    fields.targetSceneId = values.targetSceneId;
  }
  if (kind === "model" && (!initial || values.modelVersionId !== initial.model?.versionId)) {
    fields.modelVersionId = values.modelVersionId;
  }
  if (kind === "model" && (initial ? values.body !== initial.body : values.body.trim() !== "")) {
    fields.body = values.body;
  }
  if (kind === "tour" && (!initial || values.targetContentId !== initial.target?.contentId)) {
    fields.targetContentId = values.targetContentId;
  }
  return fields;
}

export function HotspotForm({
  org,
  kind,
  initial,
  scenes,
  models,
  targets,
  pending,
  onSubmit,
  onCancel,
}: {
  readonly org: string;
  readonly kind: HotspotKind;
  /** null: a new point. */
  readonly initial: EditorHotspot | null;
  /** The other scenes of this tour. */
  readonly scenes: readonly SceneOption[];
  readonly models: readonly EditorModelOption[];
  readonly targets: readonly EditorTargetOption[];
  readonly pending: boolean;
  readonly onSubmit: (fields: Record<string, unknown>) => Promise<HotspotEditState | null>;
  readonly onCancel: () => void;
}) {
  const id = useId();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [gallery, setGallery] = useState<EditorImage[]>([...(initial?.gallery ?? [])]);
  const [targetSceneId, setTargetSceneId] = useState(initial?.targetSceneId ?? "");
  const [modelVersionId, setModelVersionId] = useState(initial?.model?.versionId ?? "");
  const [targetContentId, setTargetContentId] = useState(initial?.target?.contentId ?? "");
  const [issues, setIssues] = useState<readonly HotspotIssue[]>([]);
  const [reason, setReason] = useState<string | null>(null);

  const fields = fieldsOf(
    kind,
    { title, body, gallery, targetSceneId, modelVersionId, targetContentId },
    initial,
  );
  const dirty = Object.keys(fields).length > 0;
  const issueOf = (field: HotspotIssue["field"]) => issues.find((issue) => issue.field === field);
  const chosenModel = models.find((model) => model.versionId === modelVersionId);
  const chosenTarget = targets.find((target) => target.contentId === targetContentId);
  const destinations = targets.filter((target) => target.kind === "destination");
  const events = targets.filter((target) => target.kind === "event");

  async function submit() {
    setReason(null);
    const result = await onSubmit(fields);
    if (result?.status === "rejected") setIssues(result.issues);
    else if (result?.status === "invalid") {
      setIssues([]);
      setReason(REASONS[result.reason] ?? "Revisa los campos.");
    } else setIssues([]);
  }

  const errorId = (field: string) => `${id}-${field}-error`;
  const fieldError = (field: HotspotIssue["field"]) => {
    const issue = issueOf(field);
    return issue ? (
      <p id={errorId(field)} className="field-error">
        {issueText(issue)}
      </p>
    ) : null;
  };

  return (
    <form
      className="hotspot-form"
      aria-labelledby={`${id}-heading`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      <h3 id={`${id}-heading`}>
        {initial
          ? `Editar «${initial.title}»`
          : `Nuevo punto: ${hotspotKindLabel(kind).toLowerCase()}`}
      </h3>
      <p className="field-hint">{KIND_HINT[kind]}</p>
      <div className="field">
        <label htmlFor={`${id}-title`}>Nombre del punto</label>
        <input
          id={`${id}-title`}
          value={title}
          maxLength={TOUR_LIMITS.hotspotTitle}
          required
          autoFocus
          onChange={(event) => setTitle(event.target.value)}
          aria-invalid={issueOf("title") ? true : undefined}
          aria-describedby={issueOf("title") ? errorId("title") : undefined}
        />
        {fieldError("title")}
      </div>

      {kind === "info" ? (
        <>
          <div className="field">
            <label htmlFor={`${id}-body`}>Texto</label>
            <textarea
              id={`${id}-body`}
              value={body}
              rows={5}
              onChange={(event) => setBody(event.target.value)}
              aria-invalid={issueOf("body") ? true : undefined}
              aria-describedby={`${id}-body-hint${issueOf("body") ? ` ${errorId("body")}` : ""}`}
            />
            <p id={`${id}-body-hint`} className="field-hint">
              Como en los destinos: **negrita**, *cursiva*, «- » para listas y [texto](https://…)
              para enlaces.
            </p>
            {fieldError("body")}
          </div>
          <fieldset className="field">
            <legend>Fotos (opcional)</legend>
            <GalleryField
              org={org}
              max={TOUR_LIMITS.hotspotPhotos}
              value={gallery}
              disabled={pending}
              invalidAlts={
                new Set(
                  issues
                    .filter((issue) => issue.field === "gallery" && issue.index !== undefined)
                    .map((issue) => issue.index as number),
                )
              }
              onChange={setGallery}
            />
            {fieldError("gallery")}
          </fieldset>
        </>
      ) : null}

      {kind === "scene" ? (
        <div className="field">
          <label htmlFor={`${id}-scene`}>Lleva a la escena</label>
          {scenes.length === 0 ? (
            <p className="field-hint">Este tour no tiene otras escenas todavía.</p>
          ) : (
            <select
              id={`${id}-scene`}
              value={targetSceneId}
              required
              onChange={(event) => setTargetSceneId(event.target.value)}
            >
              <option value="" disabled>
                Elige una escena
              </option>
              {scenes.map((scene) => (
                <option key={scene.sceneId} value={scene.sceneId}>
                  {scene.title}
                </option>
              ))}
            </select>
          )}
          {fieldError("target")}
        </div>
      ) : null}

      {kind === "model" ? (
        <fieldset className="field">
          <legend>Modelo 3D</legend>
          {models.length === 0 ? (
            <p className="field-hint">
              No hay modelos listos. Súbelos en <a href={`/o/${org}/modelos`}>Modelos 3D</a>.
            </p>
          ) : (
            <ul className="hotspot-models">
              {models.map((model) => (
                <li key={model.versionId}>
                  <label className="hotspot-model">
                    <input
                      type="radio"
                      name={`${id}-model`}
                      value={model.versionId}
                      checked={modelVersionId === model.versionId}
                      onChange={() => setModelVersionId(model.versionId)}
                    />
                    <span className="hotspot-model-thumb" data-empty={model.posterUrl === null}>
                      {model.posterUrl ? (
                        // Short-lived signed URL: next/image would cache it past expiry.
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={model.posterUrl} alt="" width={96} height={72} loading="lazy" />
                      ) : null}
                    </span>
                    <span>
                      {model.label}
                      {model.hasPoster ? null : (
                        <span className="cell-detail"> · sin imagen todavía</span>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {chosenModel && !chosenModel.hasPoster ? (
            <p className="notice" role="status">
              Este modelo no tiene su imagen todavía: ábrelo una vez en{" "}
              <a href={`/o/${org}/modelos`}>Modelos 3D</a> para capturarla. Sin ella el tour no se
              puede publicar.
            </p>
          ) : null}
          {fieldError("target")}
        </fieldset>
      ) : null}

      {kind === "model" ? (
        <div className="field">
          <label htmlFor={`${id}-body`}>Descripción del modelo</label>
          <textarea
            id={`${id}-body`}
            value={body}
            rows={4}
            onChange={(event) => setBody(event.target.value)}
            aria-invalid={issueOf("body") ? true : undefined}
            aria-describedby={`${id}-model-body-hint${issueOf("body") ? ` ${errorId("body")}` : ""}`}
          />
          <p id={`${id}-model-body-hint`} className="field-hint">
            Qué es y cómo se ve (forma, material, color, tamaño real). Es lo que lee quien no puede
            ver el modelo 3D o usa un lector de pantalla. Mismo formato que los destinos.
          </p>
          {fieldError("body")}
        </div>
      ) : null}

      {kind === "tour" ? (
        <div className="field">
          <label htmlFor={`${id}-target`}>Lleva al tour de</label>
          {targets.length === 0 ? (
            <p className="field-hint">No hay otros destinos ni eventos en este municipio.</p>
          ) : (
            <select
              id={`${id}-target`}
              value={targetContentId}
              required
              onChange={(event) => setTargetContentId(event.target.value)}
              aria-describedby={
                chosenTarget && !chosenTarget.tourPublished ? `${id}-target-note` : undefined
              }
            >
              <option value="" disabled>
                Elige un destino o evento
              </option>
              {destinations.length > 0 ? (
                <optgroup label="Destinos">
                  {destinations.map((target) => (
                    <option key={target.contentId} value={target.contentId}>
                      {target.title}
                      {target.tourPublished ? "" : " (sin tour publicado)"}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {events.length > 0 ? (
                <optgroup label="Eventos">
                  {events.map((target) => (
                    <option key={target.contentId} value={target.contentId}>
                      {target.title}
                      {target.tourPublished ? "" : " (sin tour publicado)"}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          )}
          {chosenTarget && !chosenTarget.tourPublished ? (
            <p id={`${id}-target-note`} className="notice" role="status">
              «{chosenTarget.title}» todavía no tiene un tour publicado: este punto no se mostrará a
              los visitantes hasta que lo tenga. No impide publicar este tour.
            </p>
          ) : null}
          {fieldError("target")}
        </div>
      ) : null}

      {reason ? (
        <p className="field-error" role="alert">
          {reason}
        </p>
      ) : null}
      <div className="row-actions">
        <button type="submit" className="button" disabled={pending || !dirty}>
          {initial ? "Guardar el punto" : "Agregar el punto"}
        </button>
        <button type="button" className="button button-quiet" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
