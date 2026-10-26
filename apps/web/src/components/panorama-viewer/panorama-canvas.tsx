"use client";

import "@photo-sphere-viewer/core/index.css";
import "@photo-sphere-viewer/markers-plugin/index.css";
import "./hotspot-markers.css";

import { Viewer } from "@photo-sphere-viewer/core";
import { MarkersPlugin, type MarkerConfig } from "@photo-sphere-viewer/markers-plugin";
import { useEffect, useRef } from "react";

import { hotspotElement, hotspotKindLabel, type HotspotMarker } from "./hotspot-markers";

/**
 * The 360° viewer (Photo Sphere Viewer 5, on the app's single three.js). Always loaded
 * with next/dynamic (ssr: false), so it never enters a page's initial bundle. The panel and,
 * from P4 · Paso 4, the portal use the same angles: yaw/pitch in radians and the field of
 * view in degrees, whatever the delivery (one image here, tiles in the portal).
 *
 * Keyboard: the arrows and +/- move the view only while the viewer has focus (the page's
 * own keys keep working elsewhere).
 */
export interface PanoramaView {
  readonly yaw: number;
  readonly pitch: number;
  readonly fov: number;
}

export interface PanoramaCanvasHandle {
  currentView(): PanoramaView;
  goTo(view: PanoramaView): void;
  /** Turns the view to a point (yaw/pitch) without changing the zoom. */
  lookAt(point: { readonly yaw: number; readonly pitch: number }): void;
}

export interface PanoramaCanvasProps {
  readonly url: string;
  /** Blurred preview shown while the image loads. */
  readonly previewUrl?: string | null | undefined;
  readonly initialView: PanoramaView;
  /** Accessible name of the viewer (the page gives the text alternative next to it). */
  readonly label: string;
  readonly onReady?: ((handle: PanoramaCanvasHandle) => void) | undefined;
  /** WebGL or the image could not load: the page says so and keeps working. */
  readonly onFailure?: (() => void) | undefined;
  /** The scene's points. */
  readonly markers?: readonly HotspotMarker[] | undefined;
  readonly onMarkerSelect?: ((id: string) => void) | undefined;
  /** While true, a click on the panorama reports where (to place or move a point). */
  readonly picking?: boolean | undefined;
  readonly onPick?: ((point: { yaw: number; pitch: number }) => void) | undefined;
}

const MIN_FOV = 30;
const MAX_FOV = 90;

/** Photo Sphere Viewer zooms from 0 (MAX_FOV) to 100 (MIN_FOV). */
function zoomLevelOf(fov: number): number {
  return Math.min(100, Math.max(0, ((MAX_FOV - fov) / (MAX_FOV - MIN_FOV)) * 100));
}

function fovOf(zoomLevel: number): number {
  return MAX_FOV - (zoomLevel / 100) * (MAX_FOV - MIN_FOV);
}

const LANG = {
  zoom: "Acercar o alejar",
  zoomOut: "Alejar",
  zoomIn: "Acercar",
  moveUp: "Mirar arriba",
  moveDown: "Mirar abajo",
  moveLeft: "Girar a la izquierda",
  moveRight: "Girar a la derecha",
  description: "Descripción",
  download: "Descargar",
  fullscreen: "Pantalla completa",
  loading: "Cargando…",
  menu: "Menú",
  close: "Cerrar",
  twoFingers: "Usa dos dedos para mover la vista",
  ctrlZoom: "Usa Ctrl + rueda para acercar",
  loadError: "No se pudo cargar el panorama",
  webglError: "Este navegador no puede mostrar la vista 360°",
};

function markerConfig(marker: HotspotMarker): MarkerConfig {
  const config: MarkerConfig = {
    id: marker.id,
    position: { yaw: marker.yaw, pitch: marker.pitch },
    element: hotspotElement(marker),
    anchor: "center center",
    data: { kind: marker.kind },
  };
  // "Go to another tour" already shows its destination on the pill.
  if (marker.kind !== "tour") {
    config.tooltip = {
      content: escapeText(`${hotspotKindLabel(marker.kind)}: ${marker.title}`),
      position: "top center",
    };
  }
  return config;
}

/** The tooltip content is HTML: the title is escaped. */
function escapeText(text: string): string {
  return text.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);
}

export default function PanoramaCanvas({
  url,
  previewUrl,
  initialView,
  label,
  onReady,
  onFailure,
  markers,
  onMarkerSelect,
  picking,
  onPick,
}: PanoramaCanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onReady, onFailure, onMarkerSelect, onPick });
  const start = useRef(initialView);
  const plugin = useRef<MarkersPlugin | null>(null);
  const pickingRef = useRef(picking ?? false);
  const markersRef = useRef(markers ?? []);
  useEffect(() => {
    callbacks.current = { onReady, onFailure, onMarkerSelect, onPick };
    pickingRef.current = picking ?? false;
  }, [onReady, onFailure, onMarkerSelect, onPick, picking]);

  // The points follow the props (a cheap key: they change only after an edit).
  const markersKey = JSON.stringify(markers ?? []);
  useEffect(() => {
    markersRef.current = markers ?? [];
    plugin.current?.setMarkers(markersRef.current.map(markerConfig));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on their content
  }, [markersKey]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let viewer: Viewer;
    try {
      viewer = new Viewer({
        container: element,
        panorama: url,
        defaultYaw: start.current.yaw,
        defaultPitch: start.current.pitch,
        defaultZoomLvl: zoomLevelOf(start.current.fov),
        minFov: MIN_FOV,
        maxFov: MAX_FOV,
        navbar: ["zoom", "move", "fullscreen"],
        keyboard: false,
        mousewheelCtrlKey: true,
        touchmoveTwoFingers: false,
        loadingTxt: LANG.loading,
        lang: LANG,
        plugins: [[MarkersPlugin, { markers: markersRef.current.map(markerConfig) }]],
      });
      plugin.current = viewer.getPlugin(MarkersPlugin);
    } catch {
      callbacks.current.onFailure?.();
      return;
    }
    const container = viewer.container;
    // Focusable, so the arrows and +/- turn and zoom (only while it has focus).
    container.tabIndex = 0;
    container.setAttribute("role", "application");
    container.setAttribute("aria-label", label);
    container.setAttribute("aria-roledescription", "vista 360°");
    const focusIn = () => viewer.startKeyboardControl();
    const focusOut = () => viewer.stopKeyboardControl();
    container.addEventListener("focusin", focusIn);
    container.addEventListener("focusout", focusOut);

    // The navbar's controls are <div>s with a title, rebuilt when the size changes: name them
    // as buttons every time.
    const nameButtons = () => {
      for (const button of container.querySelectorAll<HTMLElement>(".psv-button")) {
        // (The zoom slider has no title and is not a button.)
        const title = button.getAttribute("title");
        if (!title) continue;
        if (button.getAttribute("role") !== "button") button.setAttribute("role", "button");
        if (button.getAttribute("aria-label") !== title) button.setAttribute("aria-label", title);
      }
    };
    const buttons = new MutationObserver(nameButtons);
    buttons.observe(container, { subtree: true, childList: true, attributeFilter: ["title"] });
    nameButtons();

    viewer.addEventListener(
      "ready",
      () => {
        nameButtons();
        callbacks.current.onReady?.({
          currentView: () => {
            const position = viewer.getPosition();
            return { yaw: position.yaw, pitch: position.pitch, fov: fovOf(viewer.getZoomLevel()) };
          },
          goTo: (view) => {
            viewer.rotate({ yaw: view.yaw, pitch: view.pitch });
            viewer.zoom(zoomLevelOf(view.fov));
          },
          lookAt: (point) => viewer.rotate({ yaw: point.yaw, pitch: point.pitch }),
        });
      },
      { once: true },
    );
    viewer.addEventListener("panorama-error", () => callbacks.current.onFailure?.());
    viewer.addEventListener("click", ({ data }) => {
      // While placing, any click counts, also over a point: the markers plugin can keep a
      // point as "hovered" after the pointer left it, which would swallow the click.
      if (!pickingRef.current || data.rightclick) return;
      callbacks.current.onPick?.({ yaw: data.yaw, pitch: data.pitch });
    });
    plugin.current?.addEventListener("select-marker", ({ marker }) => {
      if (pickingRef.current) return;
      callbacks.current.onMarkerSelect?.(marker.id);
    });

    return () => {
      buttons.disconnect();
      container.removeEventListener("focusin", focusIn);
      container.removeEventListener("focusout", focusOut);
      plugin.current = null;
      viewer.destroy();
    };
  }, [url, label]);

  return (
    <div
      ref={host}
      className="panorama-canvas"
      data-picking={picking ? "true" : undefined}
      style={previewUrl ? { backgroundImage: `url("${previewUrl}")` } : undefined}
    />
  );
}
