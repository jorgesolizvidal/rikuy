import type { Viewer } from "@photo-sphere-viewer/core";
import type { MarkerConfig } from "@photo-sphere-viewer/markers-plugin";

import { hotspotElement, hotspotKindLabel, type HotspotMarker } from "./hotspot-markers";

/**
 * What the panel's and the portal's 360° viewers share: the same angles (yaw/pitch in
 * radians, field of view in degrees), the Spanish texts, the points and the accessible
 * container. Only imported by the viewers themselves (loaded with next/dynamic).
 */
export const MIN_FOV = 30;
export const MAX_FOV = 90;

/** Photo Sphere Viewer zooms from 0 (MAX_FOV) to 100 (MIN_FOV). */
export function zoomLevelOf(fov: number): number {
  return Math.min(100, Math.max(0, ((MAX_FOV - fov) / (MAX_FOV - MIN_FOV)) * 100));
}

export function fovOf(zoomLevel: number): number {
  return MAX_FOV - (zoomLevel / 100) * (MAX_FOV - MIN_FOV);
}

export const VIEWER_LANG = {
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

/**
 * Photo Sphere Viewer needs WebGL 2. Without it, its constructor does not throw: it shows
 * its own error and leaves a half-built viewer. So the viewers ask first and, without it,
 * the page shows its text alternative.
 */
export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2");
    context?.getExtension("WEBGL_lose_context")?.loseContext();
    return context !== null;
  } catch {
    return false;
  }
}

/** The tooltip content is HTML: the title is escaped. */
function escapeText(text: string): string {
  return text.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);
}

export function markerConfig(marker: HotspotMarker): MarkerConfig {
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

/**
 * Makes the viewer's container usable without a mouse: focusable (the arrows and +/- turn
 * and zoom only while it has focus), named, and its navbar controls announced as buttons.
 * Returns the cleanup.
 */
export function accessibleViewer(viewer: Viewer, label: string): () => void {
  const container = viewer.container;
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
  viewer.addEventListener("ready", nameButtons, { once: true });

  return () => {
    buttons.disconnect();
    container.removeEventListener("focusin", focusIn);
    container.removeEventListener("focusout", focusOut);
  };
}
