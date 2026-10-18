"use client";

import "leaflet/dist/leaflet.css";

import L from "leaflet";
import { useEffect, useRef, useState } from "react";

import { ADMIN_TILES } from "@/lib/map-tiles";

export interface MapPickerProps {
  readonly value: { readonly lat: number; readonly lng: number } | null;
  readonly center: { readonly lat: number; readonly lng: number; readonly zoom: number };
  readonly disabled: boolean;
  readonly onPick: (point: { lat: number; lng: number }) => void;
}

// A CSS marker: no image requests to third-party CDNs.
const MARKER = L.divIcon({
  className: "map-pin",
  html: '<span aria-hidden="true"></span>',
  iconSize: [28, 28],
  iconAnchor: [14, 28],
});

const round = (value: number) => Math.round(value * 1e6) / 1e6;

/**
 * Click (or drag the pin) to set the destination's location. The coordinate fields next
 * to it are the accessible way to do the same; the map only helps.
 */
export default function MapPicker({ value, center, disabled, onPick }: MapPickerProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.Marker | null>(null);
  const pick = useRef(onPick);
  const locked = useRef(disabled);
  const [tilesFailing, setTilesFailing] = useState(false);
  useEffect(() => {
    pick.current = onPick;
    locked.current = disabled;
  });

  useEffect(() => {
    if (!container.current) return;
    const instance = L.map(container.current, { scrollWheelZoom: false }).setView(
      value ? [value.lat, value.lng] : [center.lat, center.lng],
      value ? 16 : center.zoom,
    );
    // If the map images cannot be loaded (offline, blocked by the network or a stale
    // browser cache), say so: the coordinate fields keep working without them.
    let failed = 0;
    L.tileLayer(ADMIN_TILES.url, {
      attribution: ADMIN_TILES.attribution,
      maxZoom: ADMIN_TILES.maxZoom,
    })
      .on("tileerror", () => {
        failed += 1;
        if (failed >= 3) setTilesFailing(true);
      })
      .on("tileload", () => {
        failed = 0;
        setTilesFailing(false);
      })
      .addTo(instance);
    instance.on("click", (event: L.LeafletMouseEvent) => {
      if (!locked.current)
        pick.current({ lat: round(event.latlng.lat), lng: round(event.latlng.lng) });
    });
    map.current = instance;
    return () => {
      instance.remove();
      map.current = null;
      marker.current = null;
    };
    // The map is created once; later changes flow through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    if (value === null) {
      marker.current?.remove();
      marker.current = null;
      return;
    }
    if (marker.current) {
      marker.current.setLatLng([value.lat, value.lng]);
    } else {
      const pin = L.marker([value.lat, value.lng], {
        icon: MARKER,
        draggable: !disabled,
        keyboard: false,
        title: "Ubicación del destino",
      }).addTo(instance);
      pin.on("dragend", () => {
        const point = pin.getLatLng();
        pick.current({ lat: round(point.lat), lng: round(point.lng) });
      });
      marker.current = pin;
    }
    if (!instance.getBounds().contains([value.lat, value.lng])) {
      instance.setView([value.lat, value.lng], Math.max(instance.getZoom(), 15));
    }
  }, [value, disabled]);

  return (
    <>
      <div ref={container} className="map-picker" aria-hidden="true" />
      {tilesFailing ? (
        <p className="field-error" role="status">
          No se pudieron cargar las imágenes del mapa (sin conexión o bloqueadas por la red o la
          caché del navegador). Puedes escribir o pegar las coordenadas igual; si el problema sigue,
          recarga la página sin caché.
        </p>
      ) : null}
    </>
  );
}
