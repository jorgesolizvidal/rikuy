"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import { circleRing, type BoundingBox, type PositionFix } from "@rikuy/core";
import type { GeoJSONSource } from "maplibre-gl";
import {
  LngLatBounds,
  Map as MapLibre,
  Marker,
  NavigationControl,
  Popup,
  setWorkerUrl,
} from "maplibre-gl";
import { useEffect, useRef, useState } from "react";

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
  /**
   * The camera stopped. `fromVisitor` is true when the move followed the visitor's
   * position: such views must not be sent to the server (they reveal where they are).
   */
  readonly onMove?: ((bounds: BoundingBox, fromVisitor: boolean) => void) | undefined;
  /** The visitor's position (device only) and whether the camera follows it. */
  readonly visitor?:
    | {
        readonly fix: PositionFix | null;
        readonly follow: boolean;
        /** Frame this area once (it contains the visitor), without asking the server. */
        readonly reveal?: BoundingBox | null;
      }
    | undefined;
  /** The visitor dragged the map: stop following. */
  readonly onStopFollowing?: (() => void) | undefined;
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

const VISITOR_SOURCE = "rikuy-visitor-accuracy";
const FROM_VISITOR = { fromVisitor: true } as const;

/** The accuracy circle: a translucent area that says how sure the device is. */
function showAccuracy(instance: MapLibre, fix: PositionFix | null) {
  const data = {
    type: "FeatureCollection" as const,
    features: fix
      ? [
          {
            type: "Feature" as const,
            properties: {},
            geometry: { type: "Polygon" as const, coordinates: [circleRing(fix, fix.accuracy)] },
          },
        ]
      : [],
  };
  const source = instance.getSource<GeoJSONSource>(VISITOR_SOURCE);
  if (source) {
    source.setData(data);
    return;
  }
  instance.addSource(VISITOR_SOURCE, { type: "geojson", data });
  instance.addLayer({
    id: `${VISITOR_SOURCE}-fill`,
    type: "fill",
    source: VISITOR_SOURCE,
    paint: { "fill-color": "#1a73e8", "fill-opacity": 0.12 },
  });
  instance.addLayer({
    id: `${VISITOR_SOURCE}-line`,
    type: "line",
    source: VISITOR_SOURCE,
    paint: { "line-color": "#1a73e8", "line-opacity": 0.5, "line-width": 1 },
  });
}

function visitorElement(): HTMLElement {
  const element = document.createElement("span");
  element.className = "map-visitor";
  // The page says the same in text («Estás a…», the list sorted by distance).
  element.setAttribute("aria-hidden", "true");
  return element;
}

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
  visitor,
  onStopFollowing,
}: MapCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibre | null>(null);
  const markers = useRef(new globalThis.Map<string, Marker>());
  const openPopup = useRef<Popup | null>(null);
  const visitorMarker = useRef<Marker | null>(null);
  const [styleReady, setStyleReady] = useState(false);
  const callbacks = useRef({ onMove, onFailure, onStopFollowing });
  useEffect(() => {
    callbacks.current = { onMove, onFailure, onStopFollowing };
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
      setStyleReady(true);
    });
    // Some styles name icons their sprite lacks: draw nothing instead of logging warnings.
    instance.setMissingStyleImageResolver((id) => {
      if (!instance.hasImage(id)) {
        instance.addImage(id, { width: 1, height: 1, data: new Uint8Array(4) });
      }
    });
    instance.on("dragstart", () => callbacks.current.onStopFollowing?.());
    instance.on("error", () => {
      // Errors after the first render (a missing tile) are not fatal.
      if (!loaded) {
        window.clearTimeout(giveUp);
        callbacks.current.onFailure?.();
      }
    });
    instance.on("moveend", (event) => {
      const b = instance.getBounds();
      callbacks.current.onMove?.(
        {
          west: Math.max(-180, b.getWest()),
          south: Math.max(-90, b.getSouth()),
          east: Math.min(180, b.getEast()),
          north: Math.min(90, b.getNorth()),
        },
        (event as { fromVisitor?: unknown }).fromVisitor === true,
      );
    });

    // Follow the box's size (layout changes, CSS loading after the map, rotation).
    const resize = new ResizeObserver(() => instance.resize());
    resize.observe(container.current);

    const placed = markers.current;
    return () => {
      resize.disconnect();
      window.clearTimeout(giveUp);
      placed.clear();
      visitorMarker.current = null;
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

  // The visitor's dot and accuracy circle; the camera follows when asked.
  const fix = visitor?.fix ?? null;
  const follow = visitor?.follow ?? false;
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    if (!fix) {
      visitorMarker.current?.remove();
      visitorMarker.current = null;
    } else if (visitorMarker.current) {
      visitorMarker.current.setLngLat([fix.lng, fix.lat]);
    } else {
      visitorMarker.current = new Marker({ element: visitorElement() })
        .setLngLat([fix.lng, fix.lat])
        .addTo(instance);
    }
    if (styleReady) showAccuracy(instance, fix);
  }, [fix, styleReady]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !fix || !follow) return;
    instance.easeTo(
      {
        center: [fix.lng, fix.lat],
        zoom: Math.max(instance.getZoom(), 15),
        duration: reducedMotion() ? 0 : 600,
      },
      FROM_VISITOR,
    );
  }, [fix, follow]);

  const reveal = visitor?.reveal ?? null;
  useEffect(() => {
    const instance = map.current;
    if (!instance || !reveal) return;
    instance.fitBounds(
      new LngLatBounds([reveal.west, reveal.south], [reveal.east, reveal.north]),
      { padding: 64, maxZoom: 15, animate: !reducedMotion() },
      FROM_VISITOR,
    );
  }, [reveal]);

  // MapLibre styles its own container (position: relative), so it gets a full-size child.
  return (
    <div className="portal-map-canvas">
      <div ref={container} className="portal-map-surface" />
    </div>
  );
}
