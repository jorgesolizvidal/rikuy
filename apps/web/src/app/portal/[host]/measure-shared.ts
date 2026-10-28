/**
 * Shared pieces of the measurement panels (`?medir`): the tour's (P4 · Paso 7) and the
 * map's (Hito · Paso 3). They measure this visit on this device and nothing is sent: the
 * visitor copies the text. Whatever a browser does not offer is "no disponible", never
 * estimated.
 */

export const NA = "no disponible";

export type Section = Record<string, string>;

interface ChromeMemory {
  readonly usedJSHeapSize: number;
  readonly totalJSHeapSize: number;
}

export function heapMb(): number | null {
  const memory = (performance as Performance & { memory?: ChromeMemory }).memory;
  return memory ? memory.usedJSHeapSize / (1024 * 1024) : null;
}

export const mb = (value: number | null) => (value === null ? NA : `${value.toFixed(1)} MB`);
export const ms = (value: number | null | undefined) =>
  value === null || value === undefined ? NA : `${Math.round(value)} ms`;
export const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;
}

export function markTime(name: string): number | undefined {
  return performance.getEntriesByName(name)[0]?.startTime;
}

export async function deviceFacts(): Promise<Section> {
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

/** Time to first byte, first contents, LCP and page load, from the browser's timings. */
export function pageLoadFacts(lcp: number | null): Section {
  const navigation = performance.getEntriesByType("navigation")[0] as
    PerformanceNavigationTiming | undefined;
  return {
    "Primer byte": ms(navigation?.responseStart),
    "Primer contenido": ms(markTime("first-contentful-paint")),
    "Mayor contenido (LCP)": ms(lcp),
    "Página cargada": ms(navigation?.loadEventEnd || null),
  };
}

/** Watches the largest contentful paint; returns the reader and the cleanup. */
export function watchLcp(): { readonly latest: () => number | null; readonly stop: () => void } {
  let value: number | null = null;
  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => {
      const last = list.getEntries().at(-1);
      if (last) value = last.startTime;
    });
    observer.observe({ type: "largest-contentful-paint", buffered: true });
  } catch {
    // No LCP in this browser.
  }
  return { latest: () => value, stop: () => observer?.disconnect() };
}

/** The browser's frames for `duration` ms (while something moves on screen). */
export function recordFrames(duration: number): Promise<Section> {
  const frames: number[] = [];
  return new Promise((resolve) => {
    let last = performance.now();
    const end = last + duration;
    const tick = (now: number) => {
      frames.push(now - last);
      last = now;
      if (now < end) {
        requestAnimationFrame(tick);
        return;
      }
      const total = frames.reduce((sum, frame) => sum + frame, 0);
      resolve({
        "Cuadros por segundo (promedio)":
          total > 0 ? (frames.length / (total / 1000)).toFixed(0) : NA,
        "Cuadro p95": ms(percentile(frames, 95)),
        "Cuadros de más de 50 ms": String(frames.filter((frame) => frame > 50).length),
      });
    };
    requestAnimationFrame(tick);
  });
}

export function reportText(title: string, sections: readonly [string, Section | null][]): string {
  const section = ([name, values]: [string, Section | null]) =>
    values
      ? `${name}\n${Object.entries(values)
          .map(([key, value]) => `  ${key}: ${value}`)
          .join("\n")}`
      : `${name}\n  (sin medir)`;
  return [
    `${title} · ${location.pathname} · ${new Date().toISOString()}`,
    ...sections.map(section),
  ].join("\n\n");
}

export function copyText(text: string): Promise<boolean> {
  return (navigator.clipboard?.writeText(text) ?? Promise.reject(new Error("no clipboard"))).then(
    () => true,
    () => false,
  );
}
