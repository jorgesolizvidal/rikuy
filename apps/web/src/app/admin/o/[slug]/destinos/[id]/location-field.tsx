"use client";

import { formatCoordinates, parseCoordinates } from "@rikuy/core";
import dynamic from "next/dynamic";
import { useId, useState } from "react";

import type { MapPickerProps } from "./map-picker";

// Leaflet only in the browser and only on this page (never in the initial bundle).
const MapPicker = dynamic<MapPickerProps>(() => import("./map-picker"), {
  ssr: false,
  loading: () => <div className="map-picker map-loading">Cargando el mapa…</div>,
});

type Point = { readonly lat: number; readonly lng: number };

interface LocationFieldProps {
  readonly value: Point | null;
  readonly center: Point & { readonly zoom: number };
  readonly disabled: boolean;
  readonly error?: string | undefined;
  readonly onChange: (point: Point | null) => void;
}

function numberOrNull(text: string, min: number, max: number): number | null {
  if (text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

export function LocationField({ value, center, disabled, error, onChange }: LocationFieldProps) {
  const id = useId();
  const [lat, setLat] = useState(value ? String(value.lat) : "");
  const [lng, setLng] = useState(value ? String(value.lng) : "");
  const [paste, setPaste] = useState("");
  const [note, setNote] = useState<string | null>(null);

  // The point can also change from outside (e.g. an event copies its venue's location):
  // show it in the fields, unless they already say the same or hold a half-typed number.
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    const a = numberOrNull(lat, -90, 90);
    const b = numberOrNull(lng, -180, 180);
    const shown = a !== null && b !== null ? { lat: a, lng: b } : null;
    const differs = value
      ? shown === null || shown.lat !== value.lat || shown.lng !== value.lng
      : shown !== null;
    if (differs) {
      setLat(value ? String(value.lat) : "");
      setLng(value ? String(value.lng) : "");
    }
  }

  const apply = (point: Point | null, message: string | null = null) => {
    setLat(point ? String(point.lat) : "");
    setLng(point ? String(point.lng) : "");
    setNote(message);
    onChange(point);
  };

  const typed = (nextLat: string, nextLng: string) => {
    setLat(nextLat);
    setLng(nextLng);
    const a = numberOrNull(nextLat, -90, 90);
    const b = numberOrNull(nextLng, -180, 180);
    onChange(a !== null && b !== null ? { lat: a, lng: b } : null);
  };

  const fromDevice = () => {
    if (!("geolocation" in navigator)) {
      setNote("Este navegador no puede dar tu ubicación.");
      return;
    }
    setNote("Buscando tu ubicación…");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const point = {
          lat: Math.round(position.coords.latitude * 1e6) / 1e6,
          lng: Math.round(position.coords.longitude * 1e6) / 1e6,
        };
        apply(
          point,
          `Ubicación tomada de este dispositivo (precisión de unos ${Math.round(position.coords.accuracy)} m).`,
        );
      },
      () => setNote("No se pudo obtener tu ubicación. Revisa el permiso del navegador."),
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };

  const latInvalid = lat !== "" && numberOrNull(lat, -90, 90) === null;
  const lngInvalid = lng !== "" && numberOrNull(lng, -180, 180) === null;

  return (
    <fieldset className="location-field" disabled={disabled}>
      <legend>Ubicación</legend>
      <p id={`${id}-hint`} className="field-hint">
        Marca el punto en el mapa, pega las coordenadas copiadas de Google Maps (clic derecho sobre
        el lugar) o escríbelas. Es obligatoria para publicar.
      </p>
      <div className="location-grid">
        <div className="field">
          <label htmlFor={`${id}-lat`}>Latitud</label>
          <input
            id={`${id}-lat`}
            inputMode="decimal"
            value={lat}
            placeholder="-17.390100"
            aria-describedby={`${id}-hint`}
            aria-invalid={latInvalid || error ? true : undefined}
            onChange={(event) => typed(event.target.value, lng)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-lng`}>Longitud</label>
          <input
            id={`${id}-lng`}
            inputMode="decimal"
            value={lng}
            placeholder="-66.150200"
            aria-describedby={`${id}-hint`}
            aria-invalid={lngInvalid || error ? true : undefined}
            onChange={(event) => typed(lat, event.target.value)}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor={`${id}-paste`}>Pegar coordenadas</label>
        <div className="color-row">
          <input
            id={`${id}-paste`}
            value={paste}
            placeholder={`-17.3901, -66.1502  ó  17°23'24"S 66°09'01"W`}
            onChange={(event) => setPaste(event.target.value)}
          />
          <button
            type="button"
            className="button button-quiet"
            onClick={() => {
              const point = parseCoordinates(paste);
              if (point) {
                apply(point, `Coordenadas leídas: ${formatCoordinates(point)}.`);
                setPaste("");
              } else {
                setNote("No se entendieron esas coordenadas. Usa el formato «latitud, longitud».");
              }
            }}
          >
            Usar
          </button>
        </div>
      </div>
      <div className="location-actions">
        <button type="button" className="button button-quiet" onClick={fromDevice}>
          Usar mi ubicación actual
        </button>
        {value ? (
          <button
            type="button"
            className="button button-quiet"
            onClick={() => apply(null, "Ubicación quitada.")}
          >
            Quitar ubicación
          </button>
        ) : null}
      </div>
      <MapPicker
        value={value}
        center={center}
        disabled={disabled}
        onPick={(point) => apply(point, `Punto marcado: ${formatCoordinates(point)}.`)}
      />
      <p
        className={error || latInvalid || lngInvalid ? "field-error" : "field-hint"}
        role="status"
        aria-live="polite"
      >
        {error ??
          (latInvalid || lngInvalid
            ? "La latitud va de -90 a 90 y la longitud de -180 a 180."
            : (note ??
              (value ? `Ubicación: ${formatCoordinates(value)}` : "Sin ubicación todavía.")))}
      </p>
    </fieldset>
  );
}
