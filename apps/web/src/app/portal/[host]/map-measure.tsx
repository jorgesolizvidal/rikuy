"use client";

import "./measure.css";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  copyText,
  deviceFacts,
  heapMb,
  kb,
  markTime,
  mb,
  ms,
  pageLoadFacts,
  recordFrames,
  reportText,
  watchLcp,
  type Section,
} from "./measure-shared";

/**
 * The map's measurement panel (`/mapa?medir`, Hito · Paso 3), like the tour's: loaded only
 * with that parameter, never in the page's bundle. It measures this visit on this device —
 * load, the map's start, the data and the frames while the map moves — and shows it as
 * text to copy. Nothing is sent anywhere.
 */
interface Report {
  device: Section;
  load: Section;
  data: Section;
  smoothness: Section | null;
}

function loadFacts(lcp: number | null): Section {
  const start = markTime("rikuy:map-start");
  const ready = markTime("rikuy:map-ready");
  const idle = markTime("rikuy:map-idle");
  return {
    ...pageLoadFacts(lcp),
    "Arranque del mapa": ms(start),
    "Mapa listo (estilo cargado)": ms(ready),
    "Primera vista completa": ms(idle),
    "Del arranque a la vista completa":
      start !== undefined && idle !== undefined ? ms(idle - start) : ms(null),
  };
}

function dataFacts(): Section {
  const groups = {
    js: { n: 0, bytes: 0 },
    map: { n: 0, bytes: 0, hidden: 0 },
    other: { n: 0, bytes: 0 },
  };
  for (const entry of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) {
    const size = entry.transferSize || entry.encodedBodySize || 0;
    const foreign = new URL(entry.name).origin !== location.origin;
    if (foreign && /\.(pbf|mvt|png|webp|json)(\?|$)|\/tiles?\//u.test(entry.name)) {
      groups.map.n += 1;
      groups.map.bytes += size;
      if (size === 0) groups.map.hidden += 1;
    } else if (/\.js(\?|$)/u.test(entry.name)) {
      groups.js.n += 1;
      groups.js.bytes += size;
    } else {
      groups.other.n += 1;
      groups.other.bytes += size;
    }
  }
  return {
    JavaScript: `${groups.js.n} archivos, ${kb(groups.js.bytes)}`,
    "Mapa (estilo, teselas, íconos)": `${groups.map.n} archivos, ${kb(groups.map.bytes)}${groups.map.hidden > 0 ? ` (${groups.map.hidden} sin tamaño visible)` : ""}`,
    Otros: `${groups.other.n} archivos, ${kb(groups.other.bytes)}`,
    "Memoria JS": mb(heapMb()),
    Nota: "transferido por la red: lo que sale de la caché cuenta 0",
  };
}

export default function MapMeasure() {
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(true);
  const lcp = useRef<() => number | null>(() => null);

  const refresh = useCallback(async (extra?: Partial<Report>) => {
    const device = await deviceFacts();
    setReport((current) => ({
      device,
      load: loadFacts(lcp.current()),
      data: dataFacts(),
      smoothness: current?.smoothness ?? null,
      ...extra,
    }));
  }, []);

  useEffect(() => {
    const watcher = watchLcp();
    lcp.current = watcher.latest;
    const first = setTimeout(() => void refresh(), 1500);
    // Again once the first view of the map is complete.
    const later = setTimeout(() => void refresh(), 8000);
    return () => {
      watcher.stop();
      clearTimeout(first);
      clearTimeout(later);
    };
  }, [refresh]);

  async function measureSmoothness() {
    setBusy("Moviendo el mapa durante 5 segundos…");
    const frames = recordFrames(5000);
    window.dispatchEvent(new Event("rikuy:map-measure-pan"));
    const result = await frames;
    setBusy(null);
    await refresh({
      smoothness: {
        ...result,
        Nota: "cuadros del navegador mientras el mapa se movía solo; incluye cargar teselas nuevas",
      },
    });
  }

  const text = report
    ? reportText("Medición del mapa", [
        ["Dispositivo", report.device],
        ["Carga", report.load],
        ["Datos descargados", report.data],
        ["Fluidez al mover el mapa", report.smoothness],
      ])
    : "";
  return (
    <aside className="measure-panel" aria-label="Medición del mapa" data-open={open}>
      <div className="measure-panel-header">
        <h2>Medición del mapa</h2>
        <button type="button" className="portal-button" onClick={() => setOpen((value) => !value)}>
          {open ? "Ocultar" : "Mostrar"}
        </button>
      </div>
      {open ? (
        <>
          <p>
            Solo en este dispositivo: nada se envía. Espera a que el mapa cargue y copia el
            resultado.
          </p>
          <div className="measure-panel-actions">
            <button
              type="button"
              className="portal-button"
              disabled={busy !== null}
              onClick={() => void measureSmoothness()}
            >
              Medir la fluidez (5 s)
            </button>
            <button
              type="button"
              className="portal-button"
              disabled={!report}
              onClick={() => void copyText(text).then(setCopied)}
            >
              Copiar resultados
            </button>
          </div>
          <p role="status" className="measure-panel-status">
            {busy ?? (copied ? "Resultados copiados." : "")}
          </p>
          <pre className="measure-panel-report" tabIndex={0}>
            {text || "Midiendo la carga…"}
          </pre>
        </>
      ) : null}
    </aside>
  );
}
