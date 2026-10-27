"use client";

import "@photo-sphere-viewer/core/index.css";
import "@photo-sphere-viewer/markers-plugin/index.css";
import "./hotspot-markers.css";

import { Viewer } from "@photo-sphere-viewer/core";
import {
  EquirectangularTilesAdapter,
  type EquirectangularMultiTilesPanorama,
  type EquirectangularTilesPanorama,
} from "@photo-sphere-viewer/equirectangular-tiles-adapter";
import { MarkersPlugin } from "@photo-sphere-viewer/markers-plugin";
import { useEffect, useRef, useState } from "react";

import type { HotspotMarker } from "./hotspot-markers";
import {
  accessibleViewer,
  markerConfig,
  MAX_FOV,
  MIN_FOV,
  VIEWER_LANG,
  webglAvailable,
  zoomLevelOf,
} from "./viewer-shared";

/**
 * The portal's tour viewer (P4 · Paso 4): one Photo Sphere Viewer for the whole tour, so a
 * scene change swaps the panorama instead of rebuilding WebGL. Every scene starts with its
 * blurred preview and then loads its image (≤ 4096 px, as a single tile) or, for larger
 * sources, only the tiles of the level the screen needs (ADR-020).
 *
 * Navigation always ends on the LAST scene asked for: Photo Sphere Viewer aborts the
 * previous load and our own sequence number drops anything that resolves late, so a fast
 * series of taps never brings an old scene (or its points) back (RC-07).
 */
export interface TourCanvasScene {
  readonly id: string;
  readonly initialView: { readonly yaw: number; readonly pitch: number; readonly fov: number };
  readonly previewUrl: string;
  readonly image: { readonly url: string; readonly width: number };
  /** Level folders as public URLs: `{folderUrl}{dir}/{col}_{row}.webp`. */
  readonly tiles: {
    readonly folderUrl: string;
    readonly levels: readonly {
      readonly width: number;
      readonly cols: number;
      readonly rows: number;
      readonly dir: string;
    }[];
  } | null;
  readonly markers: readonly HotspotMarker[];
  /** Scenes this one's arrows lead to: their previews are fetched ahead. */
  readonly linkedScenes: readonly string[];
}

export interface TourCanvasHandle {
  /** Turns the view to a point (yaw/pitch) without changing the zoom. */
  lookAt(point: { readonly yaw: number; readonly pitch: number }): void;
}

export interface TourCanvasProps {
  readonly scenes: readonly TourCanvasScene[];
  /** The scene to show; changing it navigates. */
  readonly sceneId: string;
  readonly label: string;
  /** No fading or turning between scenes. */
  readonly reducedMotion: boolean;
  readonly onReady?: ((handle: TourCanvasHandle) => void) | undefined;
  /** The panorama of this scene is on screen with its points. */
  readonly onShown?: ((sceneId: string) => void) | undefined;
  readonly onMarkerSelect?: ((sceneId: string, markerId: string) => void) | undefined;
  /** "webgl": no 360° view in this browser; "scene": this scene's images did not load. */
  readonly onFailure?: ((failure: "webgl" | "scene", sceneId: string) => void) | undefined;
}

type TilesPanorama = EquirectangularTilesPanorama | EquirectangularMultiTilesPanorama;

/** What the tiles adapter loads for a scene. A small source is one tile: its whole image. */
function panoramaOf(scene: TourCanvasScene): TilesPanorama {
  const { tiles } = scene;
  if (tiles) {
    return {
      baseUrl: scene.previewUrl,
      levels: tiles.levels.map(({ width, cols, rows }) => ({ width, cols, rows })),
      tileUrl: (col, row, level) => {
        const config = tiles.levels[level];
        return config ? `${tiles.folderUrl}${config.dir}/${col}_${row}.webp` : null;
      },
    };
  }
  return {
    baseUrl: scene.previewUrl,
    width: scene.image.width,
    cols: 1,
    rows: 1,
    tileUrl: () => scene.image.url,
  };
}

/** Warms the browser cache with the previews of the scenes a scene's arrows lead to. */
function preloadPreviews(scene: TourCanvasScene, byId: ReadonlyMap<string, TourCanvasScene>) {
  for (const id of scene.linkedScenes) {
    const target = byId.get(id);
    if (target) new Image().src = target.previewUrl;
  }
}

export default function TourCanvas({
  scenes,
  sceneId,
  label,
  reducedMotion,
  onReady,
  onShown,
  onMarkerSelect,
  onFailure,
}: TourCanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const pluginRef = useRef<MarkersPlugin | null>(null);
  const callbacks = useRef({ onReady, onShown, onMarkerSelect, onFailure });
  const scenesRef = useRef(new Map(scenes.map((scene) => [scene.id, scene])));
  const reducedRef = useRef(reducedMotion);
  /** The scene the viewer was created with or last asked to show. */
  const requested = useRef(sceneId);
  /** Increases on every navigation: only the latest one may finish. */
  const sequence = useRef(0);
  const firstScene = useRef(sceneId);
  const labelRef = useRef(label);
  // The first scene's preview behind the canvas until WebGL draws.
  const [background] = useState(() => scenes.find((scene) => scene.id === sceneId)?.previewUrl);
  /** Puts a scene's points on screen once its panorama is (set by the viewer effect). */
  const showRef = useRef<((scene: TourCanvasScene) => void) | null>(null);

  useEffect(() => {
    callbacks.current = { onReady, onShown, onMarkerSelect, onFailure };
    reducedRef.current = reducedMotion;
  }, [onReady, onShown, onMarkerSelect, onFailure, reducedMotion]);

  useEffect(() => {
    scenesRef.current = new Map(scenes.map((scene) => [scene.id, scene]));
  }, [scenes]);

  // The name follows the scene without rebuilding the viewer.
  useEffect(() => {
    labelRef.current = label;
    viewerRef.current?.container.setAttribute("aria-label", label);
  }, [label]);

  // One viewer for the whole tour.
  useEffect(() => {
    const element = host.current;
    const first = scenesRef.current.get(firstScene.current);
    if (!element || !first) return;
    if (!webglAvailable()) {
      callbacks.current.onFailure?.("webgl", first.id);
      return;
    }
    let viewer: Viewer;
    try {
      viewer = new Viewer({
        container: element,
        adapter: EquirectangularTilesAdapter.withConfig({ baseBlur: true, showErrorTile: false }),
        panorama: panoramaOf(first),
        defaultYaw: first.initialView.yaw,
        defaultPitch: first.initialView.pitch,
        defaultZoomLvl: zoomLevelOf(first.initialView.fov),
        minFov: MIN_FOV,
        maxFov: MAX_FOV,
        navbar: ["zoom", "move"],
        keyboard: false,
        mousewheelCtrlKey: true,
        touchmoveTwoFingers: false,
        loadingTxt: VIEWER_LANG.loading,
        lang: VIEWER_LANG,
        plugins: [[MarkersPlugin, {}]],
      });
    } catch {
      callbacks.current.onFailure?.("webgl", first.id);
      return;
    }
    viewerRef.current = viewer;
    const plugin = viewer.getPlugin<MarkersPlugin>(MarkersPlugin);
    pluginRef.current = plugin;
    const releaseAccessibility = accessibleViewer(viewer, labelRef.current);

    const shown = (scene: TourCanvasScene) => {
      plugin.setMarkers(scene.markers.map(markerConfig));
      element.dataset.shownScene = scene.id;
      callbacks.current.onShown?.(scene.id);
      preloadPreviews(scene, scenesRef.current);
    };
    viewer.addEventListener(
      "ready",
      () => {
        // The first scene may have been replaced while the viewer started.
        if (requested.current === first.id) shown(first);
        callbacks.current.onReady?.({
          lookAt: (point) => viewer.rotate({ yaw: point.yaw, pitch: point.pitch }),
        });
      },
      { once: true },
    );
    viewer.addEventListener("panorama-error", () =>
      callbacks.current.onFailure?.("scene", requested.current),
    );
    plugin.addEventListener("select-marker", ({ marker }) =>
      callbacks.current.onMarkerSelect?.(requested.current, marker.id),
    );
    // A lost WebGL context (low memory on a phone) leaves a black canvas: say so.
    const canvas = element.querySelector("canvas");
    const contextLost = () => callbacks.current.onFailure?.("webgl", requested.current);
    canvas?.addEventListener("webglcontextlost", contextLost);

    showRef.current = shown;
    return () => {
      showRef.current = null;
      canvas?.removeEventListener("webglcontextlost", contextLost);
      releaseAccessibility();
      pluginRef.current = null;
      viewerRef.current = null;
      sequence.current += 1;
      viewer.destroy();
    };
  }, []);

  // Navigation: the last scene asked for wins.
  useEffect(() => {
    const viewer = viewerRef.current;
    const plugin = pluginRef.current;
    const scene = scenesRef.current.get(sceneId);
    if (!viewer || !plugin || !scene || requested.current === sceneId) return;
    requested.current = sceneId;
    const ticket = ++sequence.current;
    plugin.clearMarkers();
    if (host.current) delete host.current.dataset.shownScene;
    viewer
      .setPanorama(panoramaOf(scene), {
        position: { yaw: scene.initialView.yaw, pitch: scene.initialView.pitch },
        zoom: zoomLevelOf(scene.initialView.fov),
        showLoader: false,
        transition: reducedRef.current ? false : { speed: 700, rotation: false, effect: "fade" },
      })
      .then((done) => {
        if (!done || ticket !== sequence.current) return; // replaced by a later scene
        showRef.current?.(scene);
      })
      .catch(() => {
        if (ticket === sequence.current) callbacks.current.onFailure?.("scene", scene.id);
      });
  }, [sceneId]);

  return (
    <div
      ref={host}
      className="panorama-canvas tour-canvas"
      style={background ? { backgroundImage: `url("${background}")` } : undefined}
    />
  );
}
