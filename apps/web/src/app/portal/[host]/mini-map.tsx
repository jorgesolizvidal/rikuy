"use client";

import dynamic from "next/dynamic";
import type { BoundingBox } from "@rikuy/core/geo";
import { useEffect, useRef, useState, type RefObject } from "react";

import type { MapPointDto } from "@/server/portal-content";

import type { MapCanvasProps } from "./map-canvas";

const MapCanvas = dynamic<MapCanvasProps>(() => import("./map-canvas"), { ssr: false });

const ENGAGEMENT = ["scroll", "pointerdown", "keydown", "touchstart"] as const;

/**
 * Whether a small map may load: its box is on screen AND the visitor is using the page
 * (scrolls, taps, types). Opening a page never pays for MapLibre.
 */
function useEngaged(box: RefObject<HTMLDivElement | null>, shown: boolean): boolean {
  const [engaged, setEngaged] = useState(false);
  useEffect(() => {
    const element = box.current;
    if (!element || shown || engaged) return;
    let onScreen = false;
    let used = false;
    const maybe = () => {
      if (onScreen && used) setEngaged(true);
    };
    const engage = () => {
      used = true;
      maybe();
    };
    for (const type of ENGAGEMENT)
      window.addEventListener(type, engage, { passive: true, once: true });
    const observer =
      "IntersectionObserver" in window
        ? new IntersectionObserver(
            (entries) => {
              onScreen = entries.some((entry) => entry.isIntersecting);
              maybe();
            },
            { threshold: 0.25 },
          )
        : undefined;
    observer?.observe(element);
    return () => {
      for (const type of ENGAGEMENT) window.removeEventListener(type, engage);
      observer?.disconnect();
    };
  }, [box, shown, engaged]);
  return engaged;
}

/**
 * A small, still map with the place's pin. Its space is reserved from the start (no
 * layout shift). MapLibre is heavy, so it loads only when the box is on screen AND the
 * visitor is using the page — or right away if they press the button. The coordinates,
 * "Cómo llegar" and the link to /mapa say the same in text.
 */
export function MiniMap({ point }: { readonly point: MapPointDto }) {
  return (
    <LazyMap
      points={[point]}
      center={{ lat: point.lat, lng: point.lng, zoom: 15 }}
      kind={point.kind}
      label="Mostrar el mapa"
    />
  );
}

/**
 * A circuit's stops on a small, still map (C3 · Paso 5): numbered pins joined in the suggested
 * order. Same loading rules as the place's map; the page lists the stops in words.
 */
export function RouteMap({
  stops,
  area,
}: {
  readonly stops: readonly MapPointDto[];
  readonly area: BoundingBox;
}) {
  return (
    <LazyMap points={stops} bounds={area} route kind="destination" label="Mostrar el recorrido" />
  );
}

function LazyMap({
  points,
  center,
  bounds,
  route = false,
  kind,
  label,
}: {
  readonly points: readonly MapPointDto[];
  readonly center?: { readonly lat: number; readonly lng: number; readonly zoom: number };
  readonly bounds?: BoundingBox;
  readonly route?: boolean;
  readonly kind: MapPointDto["kind"];
  readonly label: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pressed, setPressed] = useState(false);
  const engaged = useEngaged(box, pressed);
  const [failed, setFailed] = useState(false);
  const show = pressed || engaged;
  const mapLabel = route ? "Mapa del recorrido" : "Mapa de la ubicación";

  if (failed) return null;
  return (
    <div ref={box} className="portal-mini-map" data-route={route ? "true" : undefined}>
      {show ? (
        // Not hidden from screen readers: the map's attribution links must stay reachable.
        // The map is still (no focusable canvas) and the page says the same in words.
        <div className="portal-mini-map-canvas" role="group" aria-label={mapLabel}>
          <MapCanvas
            points={points}
            {...(center ? { center } : {})}
            {...(bounds ? { bounds } : {})}
            interactive={false}
            route={route}
            onFailure={() => setFailed(true)}
          />
        </div>
      ) : (
        <button type="button" className="portal-mini-map-start" onClick={() => setPressed(true)}>
          <span className="map-marker" data-kind={kind} aria-hidden="true">
            <span className="map-marker-pin" />
          </span>
          <span>{label}</span>
        </button>
      )}
    </div>
  );
}
