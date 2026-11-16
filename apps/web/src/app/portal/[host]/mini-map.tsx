"use client";

import dynamic from "next/dynamic";
import { distanceMeters, type BoundingBox } from "@rikuy/core/geo";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { useVisitorLocation } from "@/lib/use-visitor-location";
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

/** Beyond this, framing the visitor and the place together would show half a continent. */
const MAX_REVEAL_DISTANCE = 300_000;

/**
 * A page's small map with the place's pin (ADR-068): it zooms and pans (+/−, two fingers on a
 * phone, Ctrl + wheel on a computer, so the page still scrolls) and, once the visitor shares
 * their position, shows their dot with a straight line to the place, framing both. The
 * position stays on the device (ADR-021). Its space is reserved from the start (no layout
 * shift). MapLibre is heavy, so it loads only when the box is on screen AND the visitor is
 * using the page, when they press the button, or when they share their position. "Cómo
 * llegar" and the link to /mapa say the same in text.
 */
export function MiniMap({ point }: { readonly point: MapPointDto }) {
  const { fix } = useVisitorLocation();
  const place = useMemo(() => ({ lat: point.lat, lng: point.lng }), [point.lat, point.lng]);
  // Frame the visitor and the place once, when the position first arrives (not on every
  // reading: the visitor may be moving the map). Far away, the place stays in view and the
  // page says the distance in words.
  const [framed, setFramed] = useState(false);
  const [reveal, setReveal] = useState<BoundingBox | null>(null);
  if (!fix && framed) {
    setFramed(false);
    setReveal(null);
  }
  if (fix && !framed) {
    setFramed(true);
    setReveal(
      distanceMeters(fix, place) > MAX_REVEAL_DISTANCE
        ? null
        : {
            west: Math.min(fix.lng, place.lng),
            south: Math.min(fix.lat, place.lat),
            east: Math.max(fix.lng, place.lng),
            north: Math.max(fix.lat, place.lat),
          },
    );
  }
  const near = fix !== null && reveal !== null;
  return (
    <LazyMap
      points={[point]}
      center={{ lat: point.lat, lng: point.lng, zoom: 15 }}
      kind={point.kind}
      label="Mostrar el mapa"
      interactive
      ready={fix !== null}
      visitor={{ fix, follow: false, reveal, lineTo: near ? place : null }}
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
  interactive = false,
  ready = false,
  visitor,
}: {
  readonly points: readonly MapPointDto[];
  readonly center?: { readonly lat: number; readonly lng: number; readonly zoom: number };
  readonly bounds?: BoundingBox;
  readonly route?: boolean;
  readonly kind: MapPointDto["kind"];
  readonly label: string;
  /** Zoom and pan (a page's map); a circuit's route stays still. */
  readonly interactive?: boolean;
  /** Load now (the visitor shared their position). */
  readonly ready?: boolean;
  readonly visitor?: MapCanvasProps["visitor"];
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pressed, setPressed] = useState(false);
  const engaged = useEngaged(box, pressed || ready);
  const [failed, setFailed] = useState(false);
  const show = pressed || engaged || ready;
  const mapLabel = route ? "Mapa del recorrido" : "Mapa de la ubicación";

  if (failed) return null;
  return (
    <div ref={box} className="portal-mini-map" data-route={route ? "true" : undefined}>
      {show ? (
        // Not hidden from screen readers: the map's attribution links and its +/− buttons
        // must stay reachable. The page says the same in words.
        <div className="portal-mini-map-canvas" role="group" aria-label={mapLabel}>
          <MapCanvas
            points={points}
            {...(center ? { center } : {})}
            {...(bounds ? { bounds } : {})}
            interactive={interactive}
            route={route}
            {...(visitor ? { visitor } : {})}
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
