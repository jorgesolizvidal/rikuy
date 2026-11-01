import type { UsageResource } from "@rikuy/core";

const MB = 1024 * 1024;
const ONE_DECIMAL = new Intl.NumberFormat("es-BO", { maximumFractionDigits: 1 });
const PERCENT = new Intl.NumberFormat("es-BO", { style: "percent", maximumFractionDigits: 0 });

export const RESOURCE_LABELS: Readonly<Record<UsageResource, string>> = {
  storage_bytes: "Almacenamiento",
  media_compute_seconds: "Procesamiento de medios",
  ai_tokens: "Asistente con IA",
};

export const RESOURCE_DETAILS: Readonly<Record<UsageResource, string>> = {
  storage_bytes:
    "Lo que ocupan las fotos, panoramas y modelos 3D del municipio: cada archivo subido más sus versiones optimizadas.",
  media_compute_seconds:
    "El tiempo que la plataforma dedica a preparar panoramas y modelos 3D. Se cuenta por mes.",
  ai_tokens:
    "Lo que usan las respuestas del asistente con IA, medido en tokens (pedazos de texto que lee y escribe el modelo). Se cuenta por día.",
};

const WHOLE = new Intl.NumberFormat("es-BO", { maximumFractionDigits: 0 });

/** Bytes as MB (or GB from 1024 MB); compute seconds as minutes; AI as tokens. */
export function formatAmount(resource: UsageResource, value: number): string {
  if (resource === "ai_tokens") return `${WHOLE.format(value)} tokens`;
  if (resource === "media_compute_seconds") {
    return value < 60 ? `${Math.round(value)} s` : `${ONE_DECIMAL.format(value / 60)} min`;
  }
  return value >= 1024 * MB
    ? `${ONE_DECIMAL.format(value / (1024 * MB))} GB`
    : `${ONE_DECIMAL.format(value / MB)} MB`;
}

export function formatShare(share: number): string {
  return Number.isFinite(share) ? PERCENT.format(Math.min(share, 9.99)) : "—";
}

/** The operator edits limits in these units. */
export const RESOURCE_INPUT_UNITS: Readonly<
  Record<UsageResource, { readonly label: string; readonly factor: number }>
> = {
  storage_bytes: { label: "MB", factor: MB },
  media_compute_seconds: { label: "min por mes", factor: 60 },
  ai_tokens: { label: "mil tokens por día", factor: 1000 },
};
