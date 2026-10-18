"use client";

import { formatBoundingBox, PORTAL_PATHS, type BoundingBox } from "@rikuy/core";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";

import type { MapPointDto } from "@/server/portal-content";

import type { MapCanvasProps } from "./map-canvas";

const MapCanvas = dynamic<MapCanvasProps>(() => import("./map-canvas"), {
  ssr: false,
  loading: () => <div className="portal-map-canvas portal-map-loading">Cargando el mapa…</div>,
});

type Kind = MapPointDto["kind"];

const LAYERS: readonly { kind: Kind; label: string }[] = [
  { kind: "destination", label: "Destinos" },
  { kind: "event", label: "Eventos próximos" },
];

/**
 * The /mapa experience: layers, the map (loaded on demand) and the same places as an
 * ordinary list of links, which is what keyboards, screen readers and phones without
 * WebGL use. Moving the map asks the server for the places in that area only.
 */
export function MapExplorer({
  initialPoints,
  initialArea,
  center,
}: {
  readonly initialPoints: readonly MapPointDto[];
  readonly initialArea: BoundingBox;
  readonly center?: { readonly lat: number; readonly lng: number; readonly zoom: number };
}) {
  const [points, setPoints] = useState(initialPoints);
  const [layers, setLayers] = useState<Record<Kind, boolean>>({ destination: true, event: true });
  const [area, setArea] = useState<BoundingBox>(initialArea);
  // A place's own center (from its page) until the visitor asks to see everything.
  const [focus, setFocus] = useState(center);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      pending.current?.abort();
      window.clearTimeout(timer.current);
    },
    [],
  );

  function moved(bounds: BoundingBox) {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      setLoading(true);
      try {
        const response = await fetch(
          `${PORTAL_PATHS.mapPlaces}?area=${encodeURIComponent(formatBoundingBox(rounded(bounds)))}`,
          { signal: controller.signal },
        );
        if (!response.ok) return;
        const body = (await response.json()) as { places: MapPointDto[] };
        setPoints(body.places);
      } catch {
        // Aborted or offline: keep what is shown.
      } finally {
        if (pending.current === controller) setLoading(false);
      }
    }, 350);
  }

  const visible = useMemo(() => points.filter((point) => layers[point.kind]), [points, layers]);
  const counts = useMemo(
    () => ({
      destination: points.filter((p) => p.kind === "destination").length,
      event: points.filter((p) => p.kind === "event").length,
    }),
    [points],
  );

  return (
    <div className="portal-map-layout">
      <fieldset className="portal-map-layers">
        <legend>Mostrar</legend>
        {LAYERS.map((layer) => (
          <label key={layer.kind} className="portal-map-layer" data-kind={layer.kind}>
            <input
              type="checkbox"
              checked={layers[layer.kind]}
              onChange={(event) =>
                setLayers((current) => ({ ...current, [layer.kind]: event.target.checked }))
              }
            />
            <span className="portal-map-swatch" aria-hidden="true" />
            {layer.label} ({counts[layer.kind]})
          </label>
        ))}
        <button
          type="button"
          className="portal-button"
          onClick={() => {
            setFocus(undefined);
            setArea({ ...initialArea });
          }}
          disabled={failed}
        >
          Ver todos
        </button>
      </fieldset>

      <div className="portal-map-frame">
        {failed ? (
          <p className="portal-map-failed" role="status">
            El mapa no está disponible en este momento. La lista tiene los mismos lugares.
          </p>
        ) : (
          <MapCanvas
            points={visible}
            bounds={focus ? undefined : area}
            center={focus}
            interactive
            onMove={moved}
            onFailure={() => setFailed(true)}
          />
        )}
      </div>

      <section className="portal-map-list" aria-labelledby="lugares-zona">
        <h2 id="lugares-zona">Lugares en esta zona</h2>
        <p className="portal-map-count" role="status" aria-live="polite">
          {loading
            ? "Buscando lugares…"
            : visible.length === 0
              ? "No hay lugares en esta zona. Aleja el mapa o activa otra capa."
              : `${visible.length} ${visible.length === 1 ? "lugar" : "lugares"}`}
        </p>
        <ul>
          {visible.map((point) => (
            <li key={point.key} data-kind={point.kind}>
              <a href={point.href}>
                <span className="portal-map-kind">
                  {point.kind === "event" ? "Evento" : "Destino"}
                </span>
                <span className="portal-map-title">{point.title}</span>
                {point.detail ? <span className="portal-map-detail">{point.detail}</span> : null}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** ~100 m precision is plenty for an area request (and keeps URLs short). */
function rounded(box: BoundingBox): BoundingBox {
  const r = (value: number) => Math.round(value * 1000) / 1000;
  return { west: r(box.west), south: r(box.south), east: r(box.east), north: r(box.north) };
}
