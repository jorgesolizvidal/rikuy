"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

import type { MapPointDto } from "@/server/portal-content";

import type { MapCanvasProps } from "./map-canvas";

const MapCanvas = dynamic<MapCanvasProps>(() => import("./map-canvas"), { ssr: false });

const ENGAGEMENT = ["scroll", "pointerdown", "keydown", "touchstart"] as const;

/**
 * A small, still map with the place's pin. Its space is reserved from the start (no
 * layout shift). MapLibre is heavy, so it loads only when the box is on screen AND the
 * visitor is using the page (scrolls, taps, types) — or right away if they press the
 * button. Opening a page never pays for the map. The coordinates, "Cómo llegar" and the
 * link to /mapa say the same in text.
 */
export function MiniMap({ point }: { readonly point: MapPointDto }) {
  const box = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = box.current;
    if (!element || show) return;
    let onScreen = false;
    let engaged = false;
    const maybeShow = () => {
      if (onScreen && engaged) setShow(true);
    };
    const engage = () => {
      engaged = true;
      maybeShow();
    };
    for (const type of ENGAGEMENT)
      window.addEventListener(type, engage, { passive: true, once: true });
    const observer =
      "IntersectionObserver" in window
        ? new IntersectionObserver(
            (entries) => {
              onScreen = entries.some((entry) => entry.isIntersecting);
              maybeShow();
            },
            { threshold: 0.25 },
          )
        : undefined;
    observer?.observe(element);
    return () => {
      for (const type of ENGAGEMENT) window.removeEventListener(type, engage);
      observer?.disconnect();
    };
  }, [show]);

  if (failed) return null;
  return (
    <div ref={box} className="portal-mini-map">
      {show ? (
        <div className="portal-mini-map-canvas" aria-hidden="true">
          <MapCanvas
            points={[point]}
            center={{ lat: point.lat, lng: point.lng, zoom: 15 }}
            interactive={false}
            onFailure={() => setFailed(true)}
          />
        </div>
      ) : (
        <button type="button" className="portal-mini-map-start" onClick={() => setShow(true)}>
          <span className="map-marker" data-kind={point.kind} aria-hidden="true">
            <span className="map-marker-pin" />
          </span>
          <span>Mostrar el mapa</span>
        </button>
      )}
    </div>
  );
}
