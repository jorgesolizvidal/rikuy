"use client";

import { normalizeHotspotPosition, TOUR_LIMITS, type HotspotKind } from "@rikuy/core";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { hotspotKindLabel, type HotspotMarker } from "@/components/panorama-viewer/hotspot-markers";
import {
  PanoramaViewer,
  type PanoramaCanvasHandle,
  type PanoramaView,
} from "@/components/panorama-viewer/panorama-viewer";

import type { HotspotEditState, SceneEditState } from "../actions";
import {
  HotspotForm,
  type EditorHotspot,
  type EditorModelOption,
  type EditorTargetOption,
  type SceneOption,
} from "./hotspot-form";

export interface EditorScene {
  readonly sceneId: string;
  readonly title: string;
  readonly description: string;
  readonly initialView: PanoramaView;
  readonly previewUrl: string | null;
  readonly imageUrl: string | null;
  readonly size: string | null;
  readonly hotspots: readonly EditorHotspot[];
}

const degrees = (radians: number) => Math.round((radians * 180) / Math.PI);

function turnText(yawRadians: number, pitchRadians: number): string {
  const yaw = degrees(yawRadians);
  const pitch = degrees(pitchRadians);
  const turn =
    yaw === 0
      ? "al centro de la foto"
      : `${Math.abs(yaw)}° a la ${yaw > 0 ? "derecha" : "izquierda"} del centro`;
  const tilt =
    pitch === 0
      ? "a la altura del horizonte"
      : `${Math.abs(pitch)}° hacia ${pitch > 0 ? "arriba" : "abajo"}`;
  return `${turn}, ${tilt}`;
}

/** The text alternative of a view (also what a screen reader hears). */
export function describeView(view: PanoramaView): string {
  return `Mira ${turnText(view.yaw, view.pitch)}, con un campo de visión de ${Math.round(view.fov)}°.`;
}

const KINDS: readonly HotspotKind[] = ["info", "scene", "model", "tour"];

type Mode =
  | { readonly type: "idle" }
  | { readonly type: "place"; readonly kind: HotspotKind }
  | { readonly type: "move"; readonly hotspotId: string };

export function SceneDetail({
  org,
  scene,
  scenes,
  models,
  targets,
  canEdit,
  pending,
  onSave,
  onAddHotspot,
  onUpdateHotspot,
  onRemoveHotspot,
}: {
  readonly org: string;
  readonly scene: EditorScene;
  readonly scenes: readonly SceneOption[];
  readonly models: readonly EditorModelOption[];
  readonly targets: readonly EditorTargetOption[];
  readonly canEdit: boolean;
  readonly pending: boolean;
  readonly onSave: (changes: Record<string, unknown>) => Promise<SceneEditState | null>;
  readonly onAddHotspot: (
    hotspot: Record<string, unknown>,
    title: string,
  ) => Promise<HotspotEditState | null>;
  readonly onUpdateHotspot: (
    hotspot: EditorHotspot,
    changes: Record<string, unknown>,
    success: string,
  ) => Promise<HotspotEditState | null>;
  readonly onRemoveHotspot: (hotspot: EditorHotspot) => Promise<HotspotEditState | null>;
}) {
  const id = useId();
  const viewer = useRef<PanoramaCanvasHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [title, setTitle] = useState(scene.title);
  const [description, setDescription] = useState(scene.description);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ type: "idle" });
  const [draft, setDraft] = useState<{
    kind: HotspotKind;
    position: { yaw: number; pitch: number };
  } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const onReady = useCallback((handle: PanoramaCanvasHandle) => {
    viewer.current = handle;
    setReady(true);
  }, []);
  const onFailure = useCallback(() => setFailed(true), []);

  const editingHotspot = scene.hotspots.find((hotspot) => hotspot.hotspotId === editing) ?? null;
  const otherScenes = scenes.filter((entry) => entry.sceneId !== scene.sceneId);
  const sceneTitle = (sceneId: string | null) =>
    scenes.find((entry) => entry.sceneId === sceneId)?.title ?? "otra escena";

  const place = useCallback(
    (point: { yaw: number; pitch: number }) => {
      const position = normalizeHotspotPosition(point);
      if (!position) return;
      if (mode.type === "place") {
        setDraft({ kind: mode.kind, position });
        setEditing(null);
      } else if (mode.type === "move") {
        const hotspot = scene.hotspots.find((entry) => entry.hotspotId === mode.hotspotId);
        if (hotspot) void onUpdateHotspot(hotspot, { position }, `Se movió «${hotspot.title}».`);
      }
      setMode({ type: "idle" });
    },
    [mode, scene.hotspots, onUpdateHotspot],
  );

  // Escape cancels placing or moving.
  useEffect(() => {
    if (mode.type === "idle") return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMode({ type: "idle" });
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [mode]);

  const markers: HotspotMarker[] = [
    ...scene.hotspots.map((hotspot) => ({
      id: hotspot.hotspotId,
      kind: hotspot.kind,
      title: hotspot.title,
      yaw: hotspot.position.yaw,
      pitch: hotspot.position.pitch,
      targetTitle: hotspot.target?.title,
      muted: hotspot.kind === "tour" && !hotspot.target?.tourPublished,
      selected: hotspot.hotspotId === editing,
    })),
    ...(draft
      ? [
          {
            id: "nuevo-punto",
            kind: draft.kind,
            title: "Nuevo punto",
            ...draft.position,
            selected: true,
          },
        ]
      : []),
  ];

  const textChanges: Record<string, unknown> = {};
  if (title.trim() !== scene.title) textChanges.title = title;
  if (description.trim() !== scene.description) textChanges.description = description;
  const dirty = Object.keys(textChanges).length > 0;

  async function saveTexts() {
    const result = await onSave(textChanges);
    if (result?.status === "rejected") {
      const issue = result.issues.find((entry) => entry.field === "title");
      setTitleError(
        issue?.code === "required"
          ? "Escribe el nombre de la escena."
          : issue
            ? `Hasta ${TOUR_LIMITS.sceneTitle} caracteres, en una línea.`
            : null,
      );
    } else setTitleError(null);
  }

  function detail(hotspot: EditorHotspot): string {
    switch (hotspot.kind) {
      case "info":
        return hotspot.gallery.length > 0
          ? `${hotspot.gallery.length === 1 ? "1 foto" : `${hotspot.gallery.length} fotos`}`
          : "Texto";
      case "scene":
        return `Lleva a «${sceneTitle(hotspot.targetSceneId)}»`;
      case "model":
        return hotspot.model?.posterUrl ? "Modelo con su imagen" : "Modelo sin imagen todavía";
      case "tour":
        return hotspot.target
          ? `Ir a «${hotspot.target.title}»${hotspot.target.tourPublished ? "" : " · sin tour publicado: no se muestra todavía"}`
          : "Sin destino";
    }
  }

  const picking = mode.type !== "idle";

  return (
    <section aria-labelledby={`${id}-heading`} className="tour-scene-detail">
      <h2 id={`${id}-heading`}>{scene.title}</h2>
      {scene.imageUrl && !failed ? (
        <PanoramaViewer
          url={scene.imageUrl}
          previewUrl={scene.previewUrl}
          initialView={scene.initialView}
          label={`Vista 360° de «${scene.title}». Arrastra o usa las flechas para mirar alrededor.`}
          onReady={onReady}
          onFailure={onFailure}
          markers={markers}
          picking={picking}
          onPick={place}
          onMarkerSelect={(markerId) => {
            if (canEdit && markerId !== "nuevo-punto") {
              setEditing(markerId);
              setDraft(null);
            }
          }}
        />
      ) : (
        <p className="notice" role="status">
          {scene.imageUrl
            ? "Este navegador no pudo mostrar la vista 360°. "
            : "El panorama de esta escena no tiene imagen disponible. "}
          {scene.imageUrl ? (
            <a href={scene.imageUrl} target="_blank" rel="noopener noreferrer">
              Abrir la imagen completa<span className="visually-hidden"> (pestaña nueva)</span>
            </a>
          ) : null}
        </p>
      )}

      {picking ? (
        <div className="hotspot-picking" role="status">
          <p>
            {mode.type === "place"
              ? `Toca el panorama donde va el punto (${hotspotKindLabel(mode.kind).toLowerCase()}), o ponlo en el centro de la vista.`
              : "Toca el panorama donde quieres el punto, o ponlo en el centro de la vista."}
          </p>
          <div className="row-actions">
            <button
              type="button"
              className="button"
              disabled={!ready}
              onClick={() => {
                const view = viewer.current?.currentView();
                if (view) place(view);
              }}
            >
              Poner en el centro de la vista
            </button>
            <button
              type="button"
              className="button button-quiet"
              onClick={() => setMode({ type: "idle" })}
            >
              Cancelar
            </button>
          </div>
        </div>
      ) : null}

      <p className="field-hint">
        <strong>Vista inicial:</strong> {describeView(scene.initialView)}
      </p>
      <div className="row-actions">
        <button
          type="button"
          className="button button-quiet"
          disabled={!ready}
          onClick={() => viewer.current?.goTo(scene.initialView)}
        >
          Ir a la vista inicial
        </button>
        {canEdit ? (
          <button
            type="button"
            className="button"
            disabled={!ready || pending}
            onClick={() => {
              const view = viewer.current?.currentView();
              if (view) void onSave({ initialView: view });
            }}
          >
            Usar esta vista como inicial
          </button>
        ) : null}
      </div>

      <section aria-labelledby={`${id}-points`} className="hotspot-section">
        <h3 id={`${id}-points`}>Puntos de esta escena</h3>
        {scene.hotspots.length === 0 ? (
          <p className="field-hint">Todavía no hay puntos en esta escena.</p>
        ) : (
          <ul className="hotspot-list">
            {scene.hotspots.map((hotspot) => (
              <li
                key={hotspot.hotspotId}
                className="hotspot-item"
                data-selected={hotspot.hotspotId === editing}
              >
                <span className="hotspot-item-kind" data-kind={hotspot.kind}>
                  {hotspotKindLabel(hotspot.kind)}
                </span>
                <span className="hotspot-item-name">
                  {hotspot.title}
                  <span className="cell-detail">
                    {detail(hotspot)} · {turnText(hotspot.position.yaw, hotspot.position.pitch)}
                  </span>
                </span>
                <span className="row-actions">
                  <button
                    type="button"
                    className="button button-quiet"
                    disabled={!ready}
                    aria-label={`Mirar hacia «${hotspot.title}»`}
                    onClick={() => viewer.current?.lookAt(hotspot.position)}
                  >
                    Mirar
                  </button>
                  {canEdit ? (
                    <>
                      <button
                        type="button"
                        className="button button-quiet"
                        aria-label={`Editar «${hotspot.title}»`}
                        onClick={() => {
                          setEditing(hotspot.hotspotId);
                          setDraft(null);
                        }}
                      >
                        Editar
                      </button>
                      <button
                        type="button"
                        className="button button-quiet"
                        disabled={pending}
                        aria-label={`Mover «${hotspot.title}»`}
                        onClick={() => setMode({ type: "move", hotspotId: hotspot.hotspotId })}
                      >
                        Mover
                      </button>
                      {removing === hotspot.hotspotId ? (
                        <>
                          <button
                            type="button"
                            className="button button-danger"
                            disabled={pending}
                            onClick={() => {
                              setRemoving(null);
                              if (editing === hotspot.hotspotId) setEditing(null);
                              void onRemoveHotspot(hotspot);
                            }}
                          >
                            Confirmar: quitar «{hotspot.title}»
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
                          aria-label={`Quitar «${hotspot.title}»`}
                          onClick={() => setRemoving(hotspot.hotspotId)}
                        >
                          Quitar
                        </button>
                      )}
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}

        {canEdit ? (
          <div className="hotspot-add">
            <p className="field-hint">Agregar un punto:</p>
            <div className="row-actions">
              {KINDS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className="button button-quiet hotspot-add-button"
                  data-kind={kind}
                  aria-pressed={mode.type === "place" && mode.kind === kind}
                  disabled={!ready || pending || (kind === "scene" && otherScenes.length === 0)}
                  onClick={() => {
                    setMode({ type: "place", kind });
                    setEditing(null);
                    setDraft(null);
                  }}
                >
                  {hotspotKindLabel(kind)}
                </button>
              ))}
            </div>
            {otherScenes.length === 0 ? (
              <p className="field-hint">
                «Ir a otra escena» necesita al menos dos escenas en el tour.
              </p>
            ) : null}
          </div>
        ) : null}

        {canEdit && draft ? (
          <HotspotForm
            key={`nuevo-${draft.kind}-${draft.position.yaw}-${draft.position.pitch}`}
            org={org}
            kind={draft.kind}
            initial={null}
            scenes={otherScenes}
            models={models}
            targets={targets}
            pending={pending}
            onCancel={() => setDraft(null)}
            onSubmit={async (fields) => {
              const result = await onAddHotspot(
                { kind: draft.kind, position: draft.position, ...fields },
                typeof fields.title === "string" ? fields.title.trim() : "",
              );
              if (result?.status === "saved") setDraft(null);
              return result;
            }}
          />
        ) : null}
        {canEdit && editingHotspot ? (
          <HotspotForm
            key={`${editingHotspot.hotspotId}-${editingHotspot.title}`}
            org={org}
            kind={editingHotspot.kind}
            initial={editingHotspot}
            scenes={otherScenes}
            models={models}
            targets={targets}
            pending={pending}
            onCancel={() => setEditing(null)}
            onSubmit={async (fields) => {
              const result = await onUpdateHotspot(
                editingHotspot,
                fields,
                `Se guardó «${editingHotspot.title}».`,
              );
              if (result?.status === "saved") setEditing(null);
              return result;
            }}
          />
        ) : null}
      </section>

      {canEdit ? (
        <form
          className="tour-scene-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveTexts();
          }}
        >
          <div className="field">
            <label htmlFor={`${id}-title`}>Nombre de la escena</label>
            <input
              id={`${id}-title`}
              value={title}
              maxLength={TOUR_LIMITS.sceneTitle}
              onChange={(event) => setTitle(event.target.value)}
              aria-invalid={titleError ? true : undefined}
              aria-describedby={titleError ? `${id}-title-error` : undefined}
              required
            />
            {titleError ? (
              <p id={`${id}-title-error`} className="field-error">
                {titleError}
              </p>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor={`${id}-description`}>Descripción</label>
            <textarea
              id={`${id}-description`}
              value={description}
              rows={3}
              maxLength={TOUR_LIMITS.sceneDescription}
              onChange={(event) => setDescription(event.target.value)}
              aria-describedby={`${id}-description-hint`}
            />
            <p id={`${id}-description-hint`} className="field-hint">
              Qué se ve en esta escena. La lee quien no puede ver la imagen y, más adelante, el
              asistente del recorrido.
            </p>
          </div>
          <button type="submit" className="button" disabled={!dirty || pending}>
            Guardar nombre y descripción
          </button>
        </form>
      ) : scene.description ? (
        <p>{scene.description}</p>
      ) : null}
    </section>
  );
}
