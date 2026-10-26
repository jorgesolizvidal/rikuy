/**
 * How the points of a scene look in the 360° viewer, for the panel and (from P4 · Paso 4)
 * the portal. Built with DOM nodes and textContent: titles are the municipality's text and
 * never become HTML. Each kind has its own icon; "go to another tour" is a labelled pill
 * with a place icon, so it never reads as just another arrow.
 */
export type HotspotMarkerKind = "info" | "scene" | "model" | "tour";

export interface HotspotMarker {
  readonly id: string;
  readonly kind: HotspotMarkerKind;
  readonly title: string;
  readonly yaw: number;
  readonly pitch: number;
  /** "Go to another tour": the destination's name, shown on the pill. */
  readonly targetTitle?: string | undefined;
  /** Shown dimmed (the panel: a "go to" whose destination has no published tour yet). */
  readonly muted?: boolean | undefined;
  readonly selected?: boolean | undefined;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** 24×24 icons (stroke), drawn with paths only. */
const ICONS: Record<HotspotMarkerKind, readonly string[]> = {
  info: ["M12 11v6", "M12 7.5v.01", "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z"],
  scene: ["M5 15l7-7 7 7"],
  model: ["M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z", "M12 12l8-4.5", "M12 12v9", "M12 12L4 7.5"],
  tour: [
    "M12 21s-6-5.3-6-10a6 6 0 1 1 12 0c0 4.7-6 10-6 10z",
    "M12 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  ],
};

const KIND_LABEL: Record<HotspotMarkerKind, string> = {
  info: "Información",
  scene: "Ir a otra escena",
  model: "Modelo 3D",
  tour: "Ir a otro recorrido",
};

export function hotspotKindLabel(kind: HotspotMarkerKind): string {
  return KIND_LABEL[kind];
}

export function hotspotIcon(kind: HotspotMarkerKind): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of ICONS[kind]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/**
 * The marker's element. Photo Sphere Viewer's markers plugin positions it and sets an inline
 * `display` on it, so the styled point goes inside a plain wrapper.
 */
export function hotspotElement(marker: HotspotMarker): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "hotspot-marker-wrap";
  const element = document.createElement("div");
  element.className = "hotspot-marker";
  element.dataset.kind = marker.kind;
  if (marker.muted) element.dataset.muted = "true";
  if (marker.selected) element.dataset.selected = "true";
  const badge = document.createElement("span");
  badge.className = "hotspot-marker-badge";
  badge.append(hotspotIcon(marker.kind));
  element.append(badge);
  if (marker.kind === "tour") {
    const label = document.createElement("span");
    label.className = "hotspot-marker-label";
    const small = document.createElement("small");
    small.textContent = "Ir a";
    const name = document.createElement("span");
    name.textContent = marker.targetTitle ?? marker.title;
    label.append(small, name);
    element.append(label);
  }
  wrapper.append(element);
  return wrapper;
}
