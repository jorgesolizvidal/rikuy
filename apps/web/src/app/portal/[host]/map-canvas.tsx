"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import type { BoundingBox } from "@rikuy/core";
import {
  LngLatBounds,
  Map as MapLibre,
  Marker,
  NavigationControl,
  Popup,
  setWorkerUrl,
} from "maplibre-gl";
import { useEffect, useRef } from "react";

import { PORTAL_MAP } from "@/lib/map-tiles";
import type { MapPointDto } from "@/server/portal-content";

/**
 * The MapLibre canvas (ADR-023). Always loaded with next/dynamic (ssr: false), so the
 * library never enters a page's initial bundle. Tenant text only reaches the DOM as
 * textContent (never as HTML). The list next to the map is the accessible equivalent.
 */
export interface MapCanvasProps {
  readonly points: readonly MapPointDto[];
  readonly bounds?: BoundingBox | undefined;
  readonly center?:
    { readonly lat: number; readonly lng: number; readonly zoom: number } | undefined;
  readonly interactive: boolean;
  readonly onMove?: ((bounds: BoundingBox) => void) | undefined;
  /** The style or WebGL could not load: the page keeps working without the map. */
  readonly onFailure?: (() => void) | undefined;
}

const SPANISH = {
  "NavigationControl.ZoomIn": "Acercar",
  "NavigationControl.ZoomOut": "Alejar",
  "NavigationControl.ResetBearing": "Orientar al norte",
  "CooperativeGesturesHandler.WindowsHelpText": "Usa Ctrl + rueda del ratón para acercar o alejar",
  "CooperativeGesturesHandler.MacHelpText": "Usa ⌘ + rueda para acercar o alejar",
  "CooperativeGesturesHandler.MobileHelpText": "Usa dos dedos para mover el mapa",
  "AttributionControl.ToggleAttribution": "Créditos del mapa",
  "Map.Title": "Mapa",
  "Marker.Title": "Lugar",
  "Popup.Close": "Cerrar",
};

let workerConfigured = false;

function popupContent(point: MapPointDto): HTMLElement {
  const box = document.createElement("div");
  box.className = "map-popup";
  const link = document.createElement("a");
  link.href = point.href;
  link.textContent = point.title;
  box.append(link);
  if (point.detail) {
    const detail = document.createElement("p");
    detail.textContent = point.detail;
    box.append(detail);
  }
  return box;
}

function markerElement(point: MapPointDto, interactive: boolean): HTMLElement {
  const element = document.createElement(interactive ? "button" : "span");
  element.className = "map-marker";
  element.dataset.kind = point.kind;
  if (interactive) {
    (element as HTMLButtonElement).type = "button";
    element.setAttribute(
      "aria-label",
      `${point.kind === "event" ? "Evento" : "Destino"}: ${point.title}`,
    );
  } else {
    element.setAttribute("aria-hidden", "true");
  }
  // MapLibre positions the element with its own transform; the pin shape is a child.
  const pin = document.createElement("span");
  pin.className = "map-marker-pin";
  element.append(pin);
  return element;
}

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function MapCanvas({
  points,
  bounds,
  center,
  interactive,
  onMove,
  onFailure,
}: MapCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibre | null>(null);
  const markers = useRef(new globalThis.Map<string, Marker>());
  const openPopup = useRef<Popup | null>(null);
  const callbacks = useRef({ onMove, onFailure });
  useEffect(() => {
    callbacks.current = { onMove, onFailure };
  });

  useEffect(() => {
    if (!container.current) return;
    if (!workerConfigured) {
      setWorkerUrl(PORTAL_MAP.workerUrl);
      workerConfigured = true;
    }
    let instance: MapLibre;
    try {
      instance = new MapLibre({
        container: container.current,
        style: PORTAL_MAP.styleUrl,
        ...(bounds
          ? { bounds: [bounds.west, bounds.south, bounds.east, bounds.north] as const }
          : {
              center: [center?.lng ?? 0, center?.lat ?? 0] as [number, number],
              zoom: center?.zoom ?? 2,
            }),
        fitBoundsOptions: { padding: 32, maxZoom: 15 },
        interactive,
        cooperativeGestures: interactive,
        attributionControl: { compact: true },
        locale: SPANISH,
        fadeDuration: reducedMotion() ? 0 : 300,
      });
    } catch {
      // No WebGL (old phone, disabled GPU): the list and the coordinates remain.
      callbacks.current.onFailure?.();
      return;
    }
    map.current = instance;
    if (interactive)
      instance.addControl(new NavigationControl({ showCompass: false }), "top-right");

    let loaded = false;
    const giveUp = window.setTimeout(() => {
      if (!loaded) callbacks.current.onFailure?.();
    }, 12_000);
    instance.on("load", () => {
      loaded = true;
      window.clearTimeout(giveUp);
    });
    instance.on("error", () => {
      // Errors after the first render (a missing tile) are not fatal.
      if (!loaded) {
        window.clearTimeout(giveUp);
        callbacks.current.onFailure?.();
      }
    });
    instance.on("moveend", () => {
      const b = instance.getBounds();
      callbacks.current.onMove?.({
        west: Math.max(-180, b.getWest()),
        south: Math.max(-90, b.getSouth()),
        east: Math.min(180, b.getEast()),
        north: Math.min(90, b.getNorth()),
      });
    });

    // Follow the box's size (layout changes, CSS loading after the map, rotation).
    const resize = new ResizeObserver(() => instance.resize());
    resize.observe(container.current);

    const placed = markers.current;
    return () => {
      resize.disconnect();
      window.clearTimeout(giveUp);
      placed.clear();
      instance.remove();
      map.current = null;
    };
    // The map is created once; points and view changes flow through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the markers in sync with the points (add new, drop missing).
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const placed = markers.current;
    const wanted = new Set(points.map((point) => point.key));
    for (const [key, marker] of placed) {
      if (!wanted.has(key)) {
        marker.remove();
        placed.delete(key);
      }
    }
    // An event at a destination shares its coordinates: spread pins on the same spot.
    const spots = new globalThis.Map<string, string[]>();
    for (const point of points) {
      const spot = `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;
      spots.set(spot, [...(spots.get(spot) ?? []), point.key]);
    }
    for (const point of points) {
      const siblings = spots.get(`${point.lat.toFixed(5)},${point.lng.toFixed(5)}`) ?? [];
      const index = siblings.indexOf(point.key);
      const offset: [number, number] = [(index - (siblings.length - 1) / 2) * 22, 0];
      const existing = placed.get(point.key);
      if (existing) {
        existing.setOffset(offset);
        continue;
      }
      const element = markerElement(point, interactive);
      const marker = new Marker({ element, anchor: "bottom", offset })
        .setLngLat([point.lng, point.lat])
        .addTo(instance);
      if (interactive) {
        // Our own handler so a keyboard "click" (Enter/Space on the button) opens it too.
        const popup = new Popup({
          offset: [offset[0], -32],
          closeButton: true,
          maxWidth: "16rem",
        }).setDOMContent(popupContent(point));
        element.addEventListener("click", (event) => {
          event.stopPropagation();
          if (openPopup.current && openPopup.current !== popup) openPopup.current.remove();
          openPopup.current = popup.setLngLat([point.lng, point.lat]).addTo(instance);
        });
      }
      placed.set(point.key, marker);
    }
  }, [points, interactive]);

  // A new requested area (e.g. "Ver todos") moves the camera.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !bounds) return;
    const target = new LngLatBounds([bounds.west, bounds.south], [bounds.east, bounds.north]);
    instance.fitBounds(target, { padding: 32, maxZoom: 15, animate: !reducedMotion() });
  }, [bounds]);

  // MapLibre styles its own container (position: relative), so it gets a full-size child.
  return (
    <div className="portal-map-canvas">
      <div ref={container} className="portal-map-surface" />
    </div>
  );
}
