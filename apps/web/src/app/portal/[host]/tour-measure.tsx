"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The tour's measurement panel (P4 · Paso 7): only with `?medir` in the address, loaded on
 * demand (never in the page's bundle). It measures this visit on this device — load, scene
 * changes, smoothness, memory and the 3D model — and shows the results as text to copy.
 * Nothing is sent anywhere: the visitor pastes the text where they want.
 *
 * Browser APIs differ: whatever a browser does not offer (the JS heap outside Chrome, the
 * phone's model, the GPU's name) is reported as "no disponible", never estimated.
 */
interface Report {
  device: Record<string, string>;
  load: Record<string, string>;
  bytes: Record<string, string>;
  changes: Record<string, string> | null;
  smoothness: Record<string, string> | null;
  model: Record<string, string>[];
}

const NA = "no disponible";

interface ChromeMemory {
  readonly usedJSHeapSize: number;
  readonly totalJSHeapSize: number;
}

function heapMb(): number | null {
  const memory = (performance as Performance & { memory?: ChromeMemory }).memory;
  return memory ? memory.usedJSHeapSize / (1024 * 1024) : null;
}

const mb = (value: number | null) => (value === null ? NA : `${value.toFixed(1)} MB`);
const ms = (value: number | null | undefined) =>
  value === null || value === undefined ? NA : `${Math.round(value)} ms`;
const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;
}

async function deviceFacts(): Promise<Record<string, string>> {
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean };
    userAgentData?: {
      brands?: { brand: string; version: string }[];
      getHighEntropyValues?: (hints: string[]) => Promise<Record<string, string>>;
    };
  };
  let model = NA;
  let platform = NA;
  try {
    const values = await nav.userAgentData?.getHighEntropyValues?.([
      "model",
      "platform",
      "platformVersion",
    ]);
    if (values?.model) model = values.model;
    if (values?.platform) platform = `${values.platform} ${values.platformVersion ?? ""}`.trim();
  } catch {
    // Not offered: stays "no disponible".
  }
  let gpu = NA;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (gl) {
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      gpu = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    // No WebGL: stays "no disponible".
  }
  const brands = nav.userAgentData?.brands
    ?.filter((brand) => !/not.?a.?brand/iu.test(brand.brand))
    .map((brand) => `${brand.brand} ${brand.version}`)
    .join(", ");
  const connection = nav.connection;
  return {
    Modelo: model,
    Sistema: platform,
    Navegador: brands || navigator.userAgent,
    "Memoria del equipo": nav.deviceMemory ? `${nav.deviceMemory} GB (aprox.)` : NA,
    Núcleos: navigator.hardwareConcurrency ? String(navigator.hardwareConcurrency) : NA,
    GPU: gpu,
    Pantalla: `${screen.width} × ${screen.height} px, densidad ${window.devicePixelRatio}`,
    Red: connection
      ? `${connection.effectiveType ?? "?"}, ~${connection.downlink ?? "?"} Mbps, ~${connection.rtt ?? "?"} ms${connection.saveData ? ", ahorro de datos" : ""}`
      : NA,
  };
}

function loadFacts(lcp: number | null): Record<string, string> {
  const navigation = performance.getEntriesByType("navigation")[0] as
    PerformanceNavigationTiming | undefined;
  const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime;
  const viewer = performance.getEntriesByName("rikuy:tour-viewer-start")[0]?.startTime;
  const shown = performance.getEntriesByName("rikuy:tour-shown")[0]?.startTime;
  return {
    "Primer byte": ms(navigation?.responseStart),
    "Primer contenido": ms(fcp),
    "Mayor contenido (LCP)": ms(lcp),
    "Página cargada": ms(navigation?.loadEventEnd || null),
    "Arranque del visor": ms(viewer),
    "Primera escena en pantalla": ms(shown),
  };
}

function bytesFacts(): Record<string, string> {
  const shown = performance.getEntriesByName("rikuy:tour-shown")[0]?.startTime ?? Infinity;
  const empty = () => ({ count: 0, bytes: 0, unknown: 0 });
  const groups = { js: empty(), panorama: empty(), model: empty(), other: empty() };
  let untilShown = 0;
  let requests = 0;
  for (const entry of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) {
    requests += 1;
    const size = entry.transferSize || entry.encodedBodySize || 0;
    if (entry.responseEnd <= shown) untilShown += size;
    const group = /\/panorama\//u.test(entry.name)
      ? groups.panorama
      : /\.glb(\?|$)/u.test(entry.name)
        ? groups.model
        : /\.js(\?|$)/u.test(entry.name)
          ? groups.js
          : groups.other;
    group.count += 1;
    group.bytes += size;
    // Another origin that does not allow timing (Timing-Allow-Origin) reports no size.
    if (size === 0 && entry.responseEnd > 0 && new URL(entry.name).origin !== location.origin) {
      group.unknown += 1;
    }
  }
  const line = (group: { count: number; bytes: number; unknown: number }) =>
    `${group.count} archivos, ${kb(group.bytes)}${group.unknown > 0 ? ` (${group.unknown} sin tamaño visible)` : ""}`;
  return {
    Peticiones: String(requests),
    "Hasta la primera escena": shown === Infinity ? NA : kb(untilShown),
    JavaScript: line(groups.js),
    Panoramas: line(groups.panorama),
    "Modelos 3D": line(groups.model),
    Otros: line(groups.other),
    Nota: "transferido por la red: lo que sale de la caché cuenta 0, y el almacenamiento de otro dominio no siempre deja ver el tamaño",
  };
}

/** Waits until the stage shows the scene it was asked for (or gives up). */
function sceneShown(stage: HTMLElement, timeout: number): Promise<number | null> {
  const start = performance.now();
  return new Promise((resolve) => {
    const done = () =>
      stage.dataset.shownScene !== undefined &&
      stage.dataset.shownScene === stage.dataset.currentScene;
    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeout);
    const observer = new MutationObserver(() => {
      if (!done()) return;
      clearTimeout(timer);
      observer.disconnect();
      resolve(performance.now() - start);
    });
    observer.observe(stage, { attributes: true });
  });
}

/** A button of the tour's bar by its accessible name ("Anterior", "Siguiente"). */
function buttonNamed(name: RegExp): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>(".tour-bar button")].find((button) =>
      name.test(button.getAttribute("aria-label") ?? button.textContent ?? ""),
    ) ?? null
  );
}

function reportText(report: Report): string {
  const section = (title: string, values: Record<string, string> | null) =>
    values
      ? `${title}\n${Object.entries(values)
          .map(([key, value]) => `  ${key}: ${value}`)
          .join("\n")}`
      : `${title}\n  (sin medir)`;
  return [
    `Medición del tour · ${location.pathname} · ${new Date().toISOString()}`,
    section("Dispositivo", report.device),
    section("Carga", report.load),
    section("Datos descargados", report.bytes),
    section("Cambios de escena", report.changes),
    section("Fluidez al girar", report.smoothness),
    ...(report.model.length > 0
      ? report.model.map((entry, index) => section(`Modelo 3D (${index + 1})`, entry))
      : [section("Modelo 3D", null)]),
  ].join("\n\n");
}

export default function TourMeasure() {
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(true);
  const lcp = useRef<number | null>(null);
  const models = useRef<Record<string, string>[]>([]);
  const heapAtStart = useRef<number | null>(null);

  const refresh = useCallback(async (extra?: Partial<Report>) => {
    const device = await deviceFacts();
    setReport((current) => ({
      device,
      load: loadFacts(lcp.current),
      bytes: bytesFacts(),
      changes: current?.changes ?? null,
      smoothness: current?.smoothness ?? null,
      model: [...models.current],
      ...extra,
    }));
  }, []);

  // LCP, and the 3D model: from "Ver en 3D" to "Modelo 3D listo." (or its failure).
  useEffect(() => {
    heapAtStart.current = heapMb();
    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver((list) => {
        const last = list.getEntries().at(-1);
        if (last) lcp.current = last.startTime;
      });
      observer.observe({ type: "largest-contentful-paint", buffered: true });
    } catch {
      // No LCP in this browser.
    }
    let opened: { at: number; heap: number | null } | null = null;
    const click = (event: MouseEvent) => {
      const button = (event.target as Element | null)?.closest(".tour-model-open");
      if (button && /Ver en 3D|Reintentar|Volver a abrir/u.test(button.textContent ?? "")) {
        opened = { at: performance.now(), heap: heapMb() };
      }
    };
    const watch = new MutationObserver(() => {
      const status = document.querySelector(".tour-model-status")?.textContent ?? "";
      if (!opened || status === "" || status.startsWith("Cargando")) return;
      const glb = (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
        .filter((entry) => /\.glb(\?|$)/u.test(entry.name))
        .at(-1);
      models.current.push({
        Resultado: status,
        "Hasta verlo": ms(performance.now() - opened.at),
        "Tamaño del modelo": glb ? kb(glb.encodedBodySize) : NA,
        "Memoria JS antes": mb(opened.heap),
        "Memoria JS con el modelo": mb(heapMb()),
      });
      opened = null;
      void refresh();
    });
    document.addEventListener("click", click, true);
    watch.observe(document.body, { subtree: true, childList: true, characterData: true });
    const first = setTimeout(() => void refresh(), 1500);
    return () => {
      observer?.disconnect();
      watch.disconnect();
      document.removeEventListener("click", click, true);
      clearTimeout(first);
    };
  }, [refresh]);

  /** 20 changes: Siguiente to the last scene, Anterior to the first, and again. */
  async function measureChanges() {
    const stage = document.querySelector<HTMLElement>(".tour-stage");
    if (!stage) return;
    setBusy("Cambiando de escena…");
    const before = heapMb();
    const times: number[] = [];
    let failed = 0;
    let forward = true;
    for (let change = 0; change < 20; change += 1) {
      let button = buttonNamed(forward ? /Siguiente/u : /Anterior/u);
      if (!button || button.disabled) {
        forward = !forward;
        button = buttonNamed(forward ? /Siguiente/u : /Anterior/u);
      }
      if (!button || button.disabled) break; // a single scene
      const shown = sceneShown(stage, 30_000);
      button.click();
      const time = await shown;
      if (time === null) failed += 1;
      else times.push(time);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    const after = heapMb();
    setBusy(null);
    await refresh({
      changes: {
        Cambios: String(times.length + failed),
        "Hasta ver la escena (mediana)": ms(percentile(times, 50)),
        "Hasta ver la escena (p95)": ms(percentile(times, 95)),
        "El más lento": ms(times.length ? Math.max(...times) : null),
        "Sin terminar en 30 s": String(failed),
        "Memoria JS al empezar la visita": mb(heapAtStart.current),
        "Memoria JS antes de los cambios": mb(before),
        "Memoria JS después": mb(after),
        Crecimiento:
          before !== null && after !== null
            ? `${(((after - before) / before) * 100).toFixed(0)} %`
            : NA,
      },
    });
  }

  /** Frames of the browser for 5 s while the visitor turns the panorama. */
  async function measureSmoothness() {
    setBusy("Gira el panorama con el dedo durante 5 segundos…");
    const frames: number[] = [];
    await new Promise<void>((resolve) => {
      let last = performance.now();
      const end = last + 5000;
      const tick = (now: number) => {
        frames.push(now - last);
        last = now;
        if (now < end) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    setBusy(null);
    const total = frames.reduce((sum, frame) => sum + frame, 0);
    await refresh({
      smoothness: {
        "Cuadros por segundo (promedio)":
          total > 0 ? (frames.length / (total / 1000)).toFixed(0) : NA,
        "Cuadro p95": ms(percentile(frames, 95)),
        "Cuadros de más de 50 ms": String(frames.filter((frame) => frame > 50).length),
        Nota: "cuadros del navegador mientras girabas; no es una medición de la GPU",
      },
    });
  }

  const text = report ? reportText(report) : "";
  return (
    <aside className="tour-measure" aria-label="Medición del tour" data-open={open}>
      <div className="tour-measure-header">
        <h2>Medición del tour</h2>
        <button type="button" className="portal-button" onClick={() => setOpen((value) => !value)}>
          {open ? "Ocultar" : "Mostrar"}
        </button>
      </div>
      {open ? (
        <>
          <p>Solo en este dispositivo: nada se envía. Prueba en este orden y copia el resultado.</p>
          <div className="tour-measure-actions">
            <button
              type="button"
              className="portal-button"
              disabled={busy !== null}
              onClick={() => void measureChanges()}
            >
              1. Medir 20 cambios de escena
            </button>
            <button
              type="button"
              className="portal-button"
              disabled={busy !== null}
              onClick={() => void measureSmoothness()}
            >
              2. Medir la fluidez (5 s)
            </button>
            <button
              type="button"
              className="portal-button"
              disabled={!report}
              onClick={() => {
                void navigator.clipboard?.writeText(text).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
            >
              Copiar resultados
            </button>
          </div>
          <p className="tour-measure-hint">
            3. Para el modelo 3D: abre su punto y pulsa «Ver en 3D»; se anota solo.
          </p>
          <p role="status" className="tour-measure-status">
            {busy ?? (copied ? "Resultados copiados." : "")}
          </p>
          <pre className="tour-measure-report" tabIndex={0}>
            {text || "Midiendo la carga…"}
          </pre>
        </>
      ) : null}
    </aside>
  );
}
