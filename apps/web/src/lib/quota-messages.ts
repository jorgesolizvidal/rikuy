import type { UsageResource } from "@rikuy/core";

/** Why an upload was refused when the municipality's quota is full (all upload forms). */
export const QUOTA_MESSAGES: Readonly<Record<UsageResource, string>> = {
  storage_bytes:
    "El municipio llegó a su límite de almacenamiento. Revisa «Uso del plan» o pide al equipo de la plataforma que lo amplíe.",
  media_compute_seconds:
    "El municipio usó su tiempo de procesamiento de este mes para panoramas y modelos 3D. Se renueva el día 1; si lo necesitas antes, pide al equipo de la plataforma que lo amplíe.",
};
