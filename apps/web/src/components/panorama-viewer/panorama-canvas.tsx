"use client";

import "@photo-sphere-viewer/core/index.css";

import { Viewer } from "@photo-sphere-viewer/core";
import { useEffect, useRef } from "react";

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

export default function PanoramaCanvas({
  url,
  previewUrl,
  initialView,
  label,
  onReady,
  onFailure,
}: PanoramaCanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onReady, onFailure });
  const start = useRef(initialView);
  useEffect(() => {
    callbacks.current = { onReady, onFailure };
  }, [onReady, onFailure]);

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
      });
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
        });
      },
      { once: true },
    );
    viewer.addEventListener("panorama-error", () => callbacks.current.onFailure?.());

    return () => {
      buttons.disconnect();
      container.removeEventListener("focusin", focusIn);
      container.removeEventListener("focusout", focusOut);
      viewer.destroy();
    };
  }, [url, label]);

  return (
    <div
      ref={host}
      className="panorama-canvas"
      style={previewUrl ? { backgroundImage: `url("${previewUrl}")` } : undefined}
    />
  );
}
