"use client";

import { neighbourScenes, startingScene, TOUR_SCENE_QUERY } from "@rikuy/core/tour-viewer";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { HotspotMarker } from "@/components/panorama-viewer/hotspot-markers";
import {
  TourViewer,
  type TourCanvasHandle,
  type TourCanvasScene,
} from "@/components/panorama-viewer/tour-viewer";

import {
  tourKey,
  type TourDataDto,
  type TourKind,
  type TourMenuEntryDto,
  type TourPointDto,
} from "./tour-dto";
import { TourMenu } from "./tour-menu";
import { PointDialog, type OpenPoint } from "./tour-point-dialog";

export type { TourDataDto, TourMenuEntryDto, TourPointDto, TourSceneDto } from "./tour-dto";

/**
 * A tour in the portal (P4 · Paso 4 and 5): the 360° viewer and, next to it, the same tour
 * as text — the current scene, its points as buttons and every scene in order. The text works
 * without WebGL (the viewer then says so and shows a flat image), with a keyboard and with a
 * screen reader; it is rendered on the server, so it is also what search engines read.
 *
 * The general tour: the menu (and every "go to another tour" point) jumps to another tour
 * without leaving the viewer. Only that tour's data is downloaded; the address becomes that
 * tour's page, so "back" returns and a shared link opens it.
 *
 * Whatever is asked last wins: a scene, or a tour whose data arrives late, never replaces a
 * later choice.
 */
export interface TourExplorerProps {
  readonly tour: TourDataDto;
  /** The general tour's menu (the visible tours, in the municipality's order). */
  readonly menu: readonly TourMenuEntryDto[];
  /** Where one tour's data is read (JSON): `{dataPath}?tipo=…&direccion=…`. */
  readonly dataPath: string;
  /** For the page title after a jump: "Tour 360° de X | {siteName}". */
  readonly siteName: string;
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

/** What the history keeps for each tour the visitor jumped to. */
interface HistoryTour {
  readonly rikuyTour: { readonly kind: TourKind; readonly slug: string };
}

function isHistoryTour(state: unknown): state is HistoryTour {
  return typeof state === "object" && state !== null && "rikuyTour" in state;
}

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

/** A plain left click on a link (not a new tab or window). */
function plainClick(event: React.MouseEvent): boolean {
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0);
}

export function TourExplorer({ tour: initial, menu, dataPath, siteName }: TourExplorerProps) {
  const [tour, setTour] = useState(initial);
  const { scenes, entrySceneId, title } = tour;
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
  const [menuOpen, setMenuOpen] = useState(false);
  /** The tour being fetched, and one that could not be. */
  const [loadingTour, setLoadingTour] = useState<string | null>(null);
  const [tourError, setTourError] = useState<TourMenuEntryDto | null>(null);
  const handle = useRef<TourCanvasHandle | null>(null);
  const stage = useRef<HTMLElement>(null);
  const menuToggle = useRef<HTMLButtonElement>(null);
  /** Increases on every tour asked for: only the latest one may land. */
  const tourTicket = useRef(0);
  const tourRequest = useRef<AbortController | null>(null);
  /** Tours already read in this visit: going back to one is instant. */
  const loaded = useRef(new Map<string, TourDataDto>([[tourKey(initial), initial]]));

  const scene = scenes.find((item) => item.id === current) ?? entry;
  const { previous, next } = neighbourScenes(model, scene.id);
  const position = scenes.findIndex((item) => item.id === scene.id) + 1;
  const currentKey = tourKey(tour);
  const others = menu.filter((item) => tourKey(item) !== currentKey);

  // The address names the scene, so a shared link opens it.
  useEffect(() => {
    if (chosen === null) return; // still where the address says
    const url = new URL(window.location.href);
    if (current === entrySceneId) url.searchParams.delete(TOUR_SCENE_QUERY);
    else url.searchParams.set(TOUR_SCENE_QUERY, current);
    if (url.href !== window.location.href) {
      window.history.replaceState(window.history.state, "", url);
    }
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

  /** Jumps to another tour without leaving the viewer (push: a new history entry). */
  const openTour = useCallback(
    async (
      target: { readonly kind: TourKind; readonly slug: string; readonly href: string },
      options: { readonly push: boolean; readonly sceneId?: string | null },
    ) => {
      const key = tourKey(target);
      const ticket = ++tourTicket.current;
      tourRequest.current?.abort();
      setMenuOpen(false);
      setTourError(null);
      if (key === currentKey) {
        tourRequest.current = null;
        setLoadingTour(null);
        if (options.sceneId !== undefined) goTo(options.sceneId ?? entrySceneId);
        return;
      }
      const request = new AbortController();
      tourRequest.current = request;
      setLoadingTour(key);
      try {
        let data = loaded.current.get(key);
        if (!data) {
          const query = new URLSearchParams({ tipo: target.kind, direccion: target.slug });
          const response = await fetch(`${dataPath}?${query}`, { signal: request.signal });
          if (!response.ok) throw new Error(`tour data: ${response.status}`);
          data = (await response.json()) as TourDataDto;
          loaded.current.set(key, data);
        }
        if (ticket !== tourTicket.current) return; // a later choice won
        const sceneId = data.scenes.some((item) => item.id === options.sceneId)
          ? (options.sceneId as string)
          : data.entrySceneId;
        setTour(data);
        setChosen(sceneId);
        setShown(null);
        setOpen(null);
        setSceneError(null);
        setLoadingTour(null);
        if (options.push) {
          const url = new URL(data.href, window.location.origin);
          if (sceneId !== data.entrySceneId) url.searchParams.set(TOUR_SCENE_QUERY, sceneId);
          const state: HistoryTour = { rikuyTour: { kind: data.kind, slug: data.slug } };
          window.history.pushState(state, "", url);
        }
        document.title = `Tour 360° de ${data.title} | ${siteName}`;
      } catch (error) {
        if (ticket !== tourTicket.current) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLoadingTour(null);
        setTourError(menu.find((item) => tourKey(item) === key) ?? { ...emptyEntry, ...target });
      }
    },
    [currentKey, dataPath, entrySceneId, goTo, menu, siteName],
  );

  // "Back" and "forward" between tours the visitor jumped to.
  useEffect(() => {
    const onPop = (event: PopStateEvent) => {
      const target = isHistoryTour(event.state)
        ? event.state.rikuyTour
        : { kind: initial.kind, slug: initial.slug };
      const href = menu.find((item) => tourKey(item) === tourKey(target))?.href ?? initial.href;
      const sceneId = new URLSearchParams(window.location.search).get(TOUR_SCENE_QUERY);
      void openTour({ ...target, href }, { push: false, sceneId });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [initial, menu, openTour]);

  useEffect(() => () => tourRequest.current?.abort(), []);

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
          void openTour(
            { kind: point.targetKind, slug: point.targetSlug, href: point.href },
            { push: true },
          );
          return;
      }
    },
    [goTo, openTour],
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
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const chooseTour = useCallback(
    (item: TourMenuEntryDto) => void openTour(item, { push: true }),
    [openTour],
  );

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stage.current?.requestFullscreen().catch(() => setFullscreen("unsupported"));
  };

  return (
    <div className="tour-explorer" data-tour={currentKey}>
      <nav aria-label="Ruta de navegación" className="portal-breadcrumb">
        <ol>
          <li>
            <a href="/">Inicio</a>
          </li>
          <li>
            <a href={tour.section.href}>{tour.section.label}</a>
          </li>
          <li>
            <a href={tour.contentHref}>{title}</a>
          </li>
          <li aria-current="page">Tour 360°</li>
        </ol>
      </nav>
      <header className="portal-tour-header">
        <p className="portal-tour-eyebrow">Tour 360°</p>
        <h1 className="portal-page-title">{title}</h1>
        {tour.ended ? (
          <p className="portal-ended" role="status">
            Este evento ya terminó. El tour sigue disponible.
          </p>
        ) : null}
      </header>

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
          {others.length > 0 ? (
            <TourMenu
              id="tour-menu"
              entries={menu}
              current={currentKey}
              loading={loadingTour}
              open={menuOpen}
              onClose={closeMenu}
              onChoose={chooseTour}
              toggle={menuToggle}
            />
          ) : null}
        </div>
        <div className="tour-bar" data-menu={others.length > 0 ? "true" : undefined}>
          {others.length > 0 ? (
            <button
              ref={menuToggle}
              type="button"
              className="tour-bar-button"
              aria-expanded={menuOpen}
              aria-controls="tour-menu"
              onClick={() => setMenuOpen((value) => !value)}
            >
              <span aria-hidden="true">☰</span>
              <span className="tour-bar-label">Tours</span>
              <span className="visually-hidden"> del municipio</span>
            </button>
          ) : null}
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
              {loadingTour ? "Abriendo el tour…" : `Escena ${position} de ${scenes.length}`}
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
        {tourError ? (
          <p className="tour-error" role="alert">
            No se pudo abrir el tour de {tourError.title || "ese lugar"}.{" "}
            <a className="portal-button" href={tourError.href}>
              Abrir su página
            </a>
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
                      <a
                        href={point.href}
                        onClick={(event) => {
                          if (!plainClick(event)) return;
                          event.preventDefault();
                          activate(point);
                        }}
                      >
                        {pointLabel(point)}
                      </a>
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
            <a href={tour.contentHref}>← Volver a {title}</a>
          </p>
        </nav>

        {others.length > 0 ? (
          <nav aria-labelledby="tour-otros" className="tour-guide-others">
            <h2 id="tour-otros">Más tours del municipio</h2>
            <ul>
              {others.map((item) => (
                <li key={tourKey(item)}>
                  <a
                    href={item.href}
                    onClick={(event) => {
                      if (!plainClick(event)) return;
                      event.preventDefault();
                      chooseTour(item);
                    }}
                  >
                    {item.title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
      </div>
    </div>
  );
}

const emptyEntry: TourMenuEntryDto = {
  kind: "destination",
  slug: "",
  title: "",
  href: "/",
  scenes: 0,
  preview: { url: "", width: 0, height: 0 },
  location: null,
  start: false,
};
