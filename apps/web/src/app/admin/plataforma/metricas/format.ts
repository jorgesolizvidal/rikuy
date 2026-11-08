import { LATENCY_OVERFLOW_MS, type MeasuredRoute, type ProbeTarget } from "@rikuy/core";

/** How metrics are written in the panel (ADR-044). Bolivia's clock for dates. */

const TIME_ZONE = "America/La_Paz";

export function formatWhen(iso: string): string {
  return new Intl.DateTimeFormat("es-BO", {
    timeZone: TIME_ZONE,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toLocaleString("es-BO", { maximumFractionDigits: 1 })} s`;
}

/** A percentile read from the histogram: the upper bound of its bucket. */
export function formatBucket(ms: number | null): string {
  if (ms === null) return "—";
  if (ms >= LATENCY_OVERFLOW_MS) return "más de 6,4 s";
  return `hasta ${formatMs(ms)}`;
}

export function formatUsd(value: number): string {
  return `${value.toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} USD`;
}

export function formatCount(value: number): string {
  return value.toLocaleString("es-BO");
}

/** «1 pedido», «3 pedidos». */
export function countOf(value: number, one: string, many: string): string {
  return `${formatCount(value)} ${value === 1 ? one : many}`;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toLocaleString("es-BO", { maximumFractionDigits: 1 })} MB`;
}

export const ROUTE_LABELS: Readonly<Record<MeasuredRoute, string>> = {
  assistant: "Asistente (preguntas)",
  dictation: "Dictado por voz",
  assistant_places: "Lugares del asistente",
  map_places: "Lugares del mapa",
  tour_data: "Datos del recorrido",
};

export const PROBE_LABELS: Readonly<Record<ProbeTarget, string>> = {
  home: "Inicio del portal",
  map: "Mapa (lee la base)",
  media: "Una imagen pública",
};

export const PROBLEM_LABELS: Readonly<Record<string, string>> = {
  photo_missing: "Foto publicada sin su copia pública",
  tour_file_missing: "Archivo de un tour publicado que no existe",
  tour_photo_missing: "Foto de un punto de un tour sin su copia pública",
  logo_missing: "Logo de la marca sin su copia pública",
  not_indexed: "Publicado y todavía sin leer por el asistente",
};

export const SURFACE_LABELS = { portal: "Portal", admin: "Panel", platform: "Plataforma" } as const;

/** «Fuente: … · Período: …», under every figure. */
export function sourceLine(source: string, period: string): string {
  return `Fuente: ${source} · Período: ${period}`;
}
