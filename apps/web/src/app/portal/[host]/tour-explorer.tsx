"use client";

import type { RichText } from "@rikuy/core";
import { neighbourScenes, startingScene, TOUR_SCENE_QUERY } from "@rikuy/core/tour-viewer";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { HotspotMarker } from "@/components/panorama-viewer/hotspot-markers";
import { RichTextView } from "@/components/rich-text";
import {
  TourViewer,
  type TourCanvasHandle,
  type TourCanvasScene,
} from "@/components/panorama-viewer/tour-viewer";
import type { ResponsiveImage } from "@/server/portal-content";

import { PortalImage } from "./portal-image";

/**
 * A tour in the portal (P4 · Paso 4): the 360° viewer and, next to it, the same tour as
 * text — the current scene, its points as buttons and every scene in order. The text works
 * without WebGL (the viewer then says so and shows a flat image), with a keyboard and with a
 * screen reader; it is rendered on the server, so it is also what search engines read.
 *
 * The scene asked for changes at once (title, points, address); the viewer follows and
 * always ends on the last one asked for.
 */
interface PointBase {
  readonly id: string;
  readonly title: string;
  readonly yaw: number;
  readonly pitch: number;
}

export type TourPointDto =
  | (PointBase & {
      readonly kind: "info";
      readonly body: RichText;
      readonly gallery: readonly ResponsiveImage[];
    })
  | (PointBase & {
      readonly kind: "scene";
      readonly targetSceneId: string;
      readonly targetTitle: string;
    })
  | (PointBase & {
      readonly kind: "model";
      readonly poster: { readonly url: string; readonly width: number; readonly height: number };
    })
  | (PointBase & { readonly kind: "tour"; readonly href: string; readonly targetTitle: string });

export interface TourSceneDto {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly initialView: { readonly yaw: number; readonly pitch: number; readonly fov: number };
  readonly previewUrl: string;
  readonly image: { readonly url: string; readonly width: number; readonly height: number };
  readonly tiles: TourCanvasScene["tiles"];
  readonly points: readonly TourPointDto[];
}

export interface TourExplorerProps {
  readonly title: string;
  readonly entrySceneId: string;
  readonly scenes: readonly TourSceneDto[];
  readonly backHref: string;
  readonly backLabel: string;
}

/** What only the browser knows; null while rendering on the server and hydrating. */
interface BrowserFacts {
  /** The scene in the address (?escena=). */
  readonly requested: string | null;
  readonly reducedMotion: boolean;
  readonly fullscreen: boolean;
}

let facts: { readonly href: string; readonly value: BrowserFacts } | null = null;

function browserFacts(): BrowserFacts {
  const href = window.location.href;
  if (facts?.href !== href) {
    facts = {
      href,
      value: {
        requested: new URLSearchParams(window.location.search).get(TOUR_SCENE_QUERY),
        reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        fullscreen: document.fullscreenEnabled,
      },
    };
  }
  return facts.value;
}

const noChanges = () => () => undefined;

const GALLERY_SIZES = "(min-width: 48rem) 44rem, 92vw";

function markerOf(point: TourPointDto): HotspotMarker {
  return {
    id: point.id,
    kind: point.kind,
    title: point.title,
    yaw: point.yaw,
    pitch: point.pitch,
    ...(point.kind === "tour" ? { targetTitle: point.targetTitle } : {}),
  };
}

function pointLabel(point: TourPointDto): string {
  switch (point.kind) {
    case "info":
      return point.title;
    case "scene":
      return `Ir a «${point.targetTitle}»`;
    case "model":
      return `Modelo 3D: ${point.title}`;
    case "tour":
      return `Ir al tour de ${point.targetTitle}`;
  }
}

const POINT_ICON: Record<TourPointDto["kind"], string> = {
  info: "i",
  scene: "↑",
  model: "◆",
  tour: "⌖",
};

type OpenPoint = Extract<TourPointDto, { kind: "info" | "model" }>;

function PointDialog({
  point,
  onClose,
}: {
  readonly point: OpenPoint | null;
  readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [photo, setPhoto] = useState(0);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (point && !element.open) {
      setPhoto(0);
      element.showModal();
    } else if (!point && element.open) {
      element.close();
    }
  }, [point]);

  const gallery = point?.kind === "info" ? point.gallery : [];
  const image = gallery[Math.min(photo, gallery.length - 1)];
  return (
    <dialog
      ref={dialog}
      className="tour-dialog"
      aria-labelledby="tour-dialog-title"
      onClose={onClose}
      onClick={(event) => {
        // A click on the backdrop (outside the box) closes it.
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      {point ? (
        <div className="tour-dialog-box">
          <header className="tour-dialog-header">
            <p className="tour-dialog-kind">
              {point.kind === "model" ? "Modelo 3D" : "Información"}
            </p>
            <h2 id="tour-dialog-title">{point.title}</h2>
            <button
              type="button"
              className="tour-dialog-close"
              onClick={() => dialog.current?.close()}
            >
              <span aria-hidden="true">×</span>
              <span className="visually-hidden">Cerrar</span>
            </button>
          </header>
          {point.kind === "info" ? (
            <>
              {point.body.length > 0 ? (
                <div className="portal-prose tour-dialog-body">
                  <RichTextView blocks={point.body} />
                </div>
              ) : null}
              {image ? (
                <figure className="tour-gallery" aria-roledescription="galería">
                  <PortalImage image={image} sizes={GALLERY_SIZES} priority />
                  {gallery.length > 1 ? (
                    <figcaption className="tour-gallery-controls">
                      <button
                        type="button"
                        className="portal-button"
                        disabled={photo === 0}
                        onClick={() => setPhoto((index) => Math.max(0, index - 1))}
                      >
                        Anterior
                      </button>
                      <span aria-live="polite">
                        Foto {photo + 1} de {gallery.length}
                      </span>
                      <button
                        type="button"
                        className="portal-button"
                        disabled={photo >= gallery.length - 1}
                        onClick={() => setPhoto((index) => Math.min(gallery.length - 1, index + 1))}
                      >
                        Siguiente
                      </button>
                    </figcaption>
                  ) : null}
                </figure>
              ) : null}
            </>
          ) : (
            <figure className="tour-model-poster">
              {/* eslint-disable-next-line @next/next/no-img-element -- published, versioned derivative */}
              <img
                src={point.poster.url}
                width={point.poster.width}
                height={point.poster.height}
                alt={`Imagen del modelo 3D «${point.title}»`}
              />
            </figure>
          )}
        </div>
      ) : null}
    </dialog>
  );
}

export function TourExplorer({
  title,
  entrySceneId,
  scenes,
  backHref,
  backLabel,
}: TourExplorerProps) {
  const model = useMemo(() => ({ entrySceneId, scenes }), [entrySceneId, scenes]);
  const browser = useSyncExternalStore(noChanges, browserFacts, () => null);
  // The viewer (three.js and Photo Sphere Viewer, ~200 KB) starts once the page has loaded
  // and the browser is idle: the scene's preview and the text come first.
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let cancel: (() => void) | undefined;
    const start = () => setIdle(true);
    const later = () => {
      if (typeof window.requestIdleCallback === "function") {
        const handle = window.requestIdleCallback(start, { timeout: 1500 });
        cancel = () => window.cancelIdleCallback(handle);
      } else {
        // Safari: no idle callback.
        const handle = setTimeout(start, 200);
        cancel = () => clearTimeout(handle);
      }
    };
    if (document.readyState === "complete") later();
    else window.addEventListener("load", later, { once: true });
    return () => {
      window.removeEventListener("load", later);
      cancel?.();
    };
  }, []);
  const started = browser !== null && idle;
  const entry = startingScene(model, null);
  /** The scene the visitor asked for (null: the one in the address, else the entry). */
  const [chosen, setChosen] = useState<string | null>(null);
  const current = chosen ?? startingScene(model, browser?.requested ?? null).id;
  /** The scene on screen in the viewer (null while it loads). */
  const [shown, setShown] = useState<string | null>(null);
  const [webgl, setWebgl] = useState(true);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenPoint | null>(null);
  const [fullscreenState, setFullscreen] = useState<"unsupported" | "off" | "on" | null>(null);
  const fullscreen = fullscreenState ?? (browser?.fullscreen ? "off" : "unsupported");
  const reducedMotion = browser?.reducedMotion ?? false;
  const [attempt, setAttempt] = useState(0);
  const handle = useRef<TourCanvasHandle | null>(null);
  const stage = useRef<HTMLElement>(null);

  const scene = scenes.find((item) => item.id === current) ?? entry;
  const { previous, next } = neighbourScenes(model, scene.id);
  const position = scenes.findIndex((item) => item.id === scene.id) + 1;

  // The address names the scene, so a shared link opens it.
  useEffect(() => {
    if (chosen === null) return; // still where the address says
    const url = new URL(window.location.href);
    if (current === entrySceneId) url.searchParams.delete(TOUR_SCENE_QUERY);
    else url.searchParams.set(TOUR_SCENE_QUERY, current);
    if (url.href !== window.location.href) window.history.replaceState(null, "", url);
  }, [chosen, current, entrySceneId]);

  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement ? "on" : "off");
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);

  const goTo = useCallback((sceneId: string) => {
    setSceneError(null);
    setChosen(sceneId);
  }, []);

  const activate = useCallback(
    (point: TourPointDto) => {
      switch (point.kind) {
        case "info":
        case "model":
          handle.current?.lookAt(point);
          setOpen(point);
          return;
        case "scene":
          goTo(point.targetSceneId);
          return;
        case "tour":
          window.location.assign(point.href);
          return;
      }
    },
    [goTo],
  );

  const canvasScenes = useMemo<TourCanvasScene[]>(
    () =>
      scenes.map((item) => ({
        id: item.id,
        initialView: item.initialView,
        previewUrl: item.previewUrl,
        image: { url: item.image.url, width: item.image.width },
        tiles: item.tiles,
        markers: item.points.map(markerOf),
        linkedScenes: item.points.flatMap((point) =>
          point.kind === "scene" ? [point.targetSceneId] : [],
        ),
      })),
    [scenes],
  );

  const onMarkerSelect = useCallback(
    (sceneId: string, markerId: string) => {
      const point = scenes
        .find((item) => item.id === sceneId)
        ?.points.find((p) => p.id === markerId);
      if (point) activate(point);
    },
    [scenes, activate],
  );
  const onShown = useCallback((sceneId: string) => setShown(sceneId), []);
  const onFailure = useCallback((failure: "webgl" | "scene", sceneId: string) => {
    if (failure === "webgl") setWebgl(false);
    else setSceneError(sceneId);
  }, []);
  const onReady = useCallback((ready: TourCanvasHandle) => {
    handle.current = ready;
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stage.current?.requestFullscreen().catch(() => setFullscreen("unsupported"));
  };

  return (
    <div className="tour-explorer">
      <section
        ref={stage}
        className="tour-stage"
        aria-label={`Tour 360° de ${title}`}
        data-current-scene={scene.id}
        data-shown-scene={shown ?? undefined}
      >
        <div className="tour-viewport" style={{ backgroundImage: `url("${scene.previewUrl}")` }}>
          {webgl && started ? (
            <TourViewer
              key={attempt}
              scenes={canvasScenes}
              sceneId={scene.id}
              label={`Vista 360° de «${scene.title}». Arrastra o usa las flechas para mirar alrededor.`}
              reducedMotion={reducedMotion}
              onReady={onReady}
              onShown={onShown}
              onMarkerSelect={onMarkerSelect}
              onFailure={onFailure}
            />
          ) : webgl ? (
            // Before the viewer loads: the scene's preview (the viewport's background).
            <div className="panorama-canvas tour-canvas" aria-hidden="true" />
          ) : (
            <div className="tour-flat">
              <p role="status" className="tour-flat-notice">
                Este navegador no puede mostrar la vista 360°. Puedes recorrer el tour con la lista
                de escenas y sus puntos.
              </p>
              {/* eslint-disable-next-line @next/next/no-img-element -- published, versioned derivative */}
              <img
                src={scene.image.url}
                width={scene.image.width}
                height={scene.image.height}
                alt={`Panorama de «${scene.title}», en una imagen plana`}
                loading="lazy"
                decoding="async"
              />
            </div>
          )}
        </div>
        <div className="tour-bar">
          <button
            type="button"
            className="tour-bar-button"
            disabled={!previous}
            onClick={() => previous && goTo(previous.id)}
          >
            <span aria-hidden="true">‹</span>
            <span className="tour-bar-label">Anterior</span>
            {previous ? <span className="visually-hidden">: {previous.title}</span> : null}
          </button>
          <p className="tour-bar-title" aria-live="polite">
            <strong>{scene.title}</strong>
            <span>
              Escena {position} de {scenes.length}
            </span>
          </p>
          <button
            type="button"
            className="tour-bar-button"
            disabled={!next}
            onClick={() => next && goTo(next.id)}
          >
            <span className="tour-bar-label">Siguiente</span>
            <span aria-hidden="true">›</span>
            {next ? <span className="visually-hidden">: {next.title}</span> : null}
          </button>
          {fullscreen === "unsupported" ? null : (
            <button
              type="button"
              className="tour-bar-button tour-bar-fullscreen"
              aria-pressed={fullscreen === "on"}
              onClick={toggleFullscreen}
            >
              <span aria-hidden="true">⤢</span>
              <span className="visually-hidden">Pantalla completa</span>
            </button>
          )}
        </div>
        {sceneError === scene.id ? (
          <p className="tour-error" role="alert">
            No se pudo cargar esta escena.{" "}
            <button
              type="button"
              className="portal-button"
              onClick={() => {
                setSceneError(null);
                setAttempt((value) => value + 1);
              }}
            >
              Reintentar
            </button>
          </p>
        ) : null}
        <PointDialog point={open} onClose={() => setOpen(null)} />
      </section>

      <div className="tour-guide">
        <section aria-labelledby="tour-escena" className="tour-guide-scene">
          <h2 id="tour-escena">{scene.title}</h2>
          {scene.description ? <p>{scene.description}</p> : null}
          {scene.points.length > 0 ? (
            <>
              <h3>En esta escena</h3>
              <ul className="tour-points">
                {scene.points.map((point) => (
                  <li key={point.id} data-kind={point.kind}>
                    <span className="tour-point-icon" aria-hidden="true">
                      {POINT_ICON[point.kind]}
                    </span>
                    {point.kind === "tour" ? (
                      <a href={point.href}>{pointLabel(point)}</a>
                    ) : (
                      <button type="button" className="tour-point" onClick={() => activate(point)}>
                        {pointLabel(point)}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>

        <nav aria-labelledby="tour-escenas" className="tour-guide-scenes">
          <h2 id="tour-escenas">Escenas del tour</h2>
          <ol className="tour-scene-list">
            {scenes.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="tour-scene-button"
                  aria-current={item.id === scene.id ? "true" : undefined}
                  onClick={() => goTo(item.id)}
                >
                  {item.title}
                </button>
              </li>
            ))}
          </ol>
          <p>
            <a href={backHref}>← Volver a {backLabel}</a>
          </p>
        </nav>
      </div>
    </div>
  );
}
