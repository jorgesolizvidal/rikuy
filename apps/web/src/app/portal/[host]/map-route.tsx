"use client";

import "./map-route.css";

import { describeProximity, distanceMeters, PORTAL_PATHS, type BoundingBox } from "@rikuy/core";
import dynamic from "next/dynamic";
import { useState } from "react";

import { useVisitorLocation } from "@/lib/use-visitor-location";
import type { MapPointDto } from "@/server/portal-content";

import type { MapCanvasProps } from "./map-canvas";
import { LocationButton } from "./visitor-location";

const MapCanvas = dynamic<MapCanvasProps>(() => import("./map-canvas"), {
  ssr: false,
  loading: () => <div className="portal-map-canvas portal-map-loading">Cargando el mapa…</div>,
});

/**
 * A route of the assistant on the map (`/mapa?ruta=…`, ADR-039): its stops numbered and
 * joined by straight lines, and the same stops as a list of links in order (which is what
 * keyboards, screen readers and phones without WebGL use). Nothing is asked to the server:
 * the page brought the stops.
 */
export function MapRoute({
  stops,
  area,
}: {
  readonly stops: readonly MapPointDto[];
  readonly area: BoundingBox;
}) {
  const { fix } = useVisitorLocation();
  const [failed, setFailed] = useState(false);
  const legs = stops.map((stop, index) => {
    const previous = stops[index - 1];
    return previous ? describeProximity(distanceMeters(previous, stop)) : null;
  });

  return (
    <div className="portal-map-layout portal-map-route">
      <div className="portal-map-visitor">
        <LocationButton />
        <a className="portal-button" href={PORTAL_PATHS.map}>
          Quitar la ruta
        </a>
      </div>

      <div className="portal-map-frame">
        {failed ? (
          <p className="portal-map-failed" role="status">
            El mapa no está disponible en este momento. La lista tiene la misma ruta.
          </p>
        ) : (
          <MapCanvas
            points={stops}
            bounds={area}
            interactive
            route
            onFailure={() => setFailed(true)}
            visitor={{ fix, follow: false }}
          />
        )}
      </div>

      <section className="portal-map-list" aria-labelledby="ruta-paradas">
        <h2 id="ruta-paradas">La ruta, en orden</h2>
        <p className="portal-map-count">
          {stops.length} {stops.length === 1 ? "parada" : "paradas"}. Las líneas y las distancias
          son en línea recta; los tiempos a pie son estimados.
        </p>
        <ol className="portal-route-stops">
          {stops.map((stop, index) => (
            <li key={stop.key} data-kind={stop.kind}>
              <a href={stop.href}>
                <span className="portal-route-number" aria-hidden="true">
                  {stop.order ?? index + 1}
                </span>
                <span className="portal-map-kind">
                  {stop.kind === "event" ? "Evento" : "Destino"}
                </span>
                <span className="portal-map-title">{stop.title}</span>
                {legs[index] ? (
                  <span className="portal-map-detail">
                    {legs[index]?.distance} desde la anterior
                    {legs[index]?.travel ? ` · ${legs[index]?.travel}` : ""}
                  </span>
                ) : fix ? (
                  <span className="portal-distance">
                    {describeProximity(distanceMeters(fix, stop)).distance} de ti
                  </span>
                ) : null}
              </a>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
