import {
  PANORAMA_RULES,
  type PanoramaCard,
  type PanoramaManifest,
  type PanoramaProblem,
} from "@rikuy/core";

const MAX_MB = PANORAMA_RULES.maxBytes / (1024 * 1024);
const MIN = `${PANORAMA_RULES.minSide * 2} × ${PANORAMA_RULES.minSide}`;
const MAX = `${PANORAMA_RULES.maxSide} × ${PANORAMA_RULES.maxSide / 2}`;

export const PANORAMA_HINT = `Foto 360° equirectangular (el ancho es el doble del alto), JPG, PNG o WebP de hasta ${MAX_MB} MB, entre ${MIN} y ${MAX} px. El original se guarda tal cual; las versiones para el visor se preparan solas.`;

export const PANORAMA_PROBLEMS: Readonly<Record<PanoramaProblem, string>> = {
  unsupported_type: "Usa una foto JPG, PNG o WebP.",
  too_heavy: `La foto pesa más de ${MAX_MB} MB. Expórtala con un poco más de compresión.`,
  type_mismatch: "El archivo no es del tipo que indica su nombre. Expórtalo de nuevo.",
  too_small: `La foto es muy pequeña: necesita al menos ${MIN} px.`,
  too_large: `La foto es demasiado grande: hasta ${MAX} px.`,
  unreadable: "No pudimos leer la foto (puede estar dañada). Prueba con otro archivo.",
  not_equirectangular:
    "No es una foto 360°: el ancho debe ser el doble del alto (por ejemplo, 8192 × 4096 px).",
};

export const PANORAMA_STATUS: Readonly<Record<PanoramaCard["status"], string>> = {
  uploading: "Subiendo",
  processing: "Procesando",
  ready: "Listo",
  rejected: "Rechazado",
};

const NUMBER = new Intl.NumberFormat("es-BO", { maximumFractionDigits: 1 });

export function formatMegabytes(bytes: number): string {
  return `${NUMBER.format(bytes / (1024 * 1024))} MB`;
}

/** How the visitor's viewer will receive it (ADR-020). */
export function deliveryLabel(manifest: PanoramaManifest): string {
  if (!manifest.tiles) return `Imagen única de ${manifest.image.width} px`;
  const levels = manifest.tiles.levels;
  const tiles = levels.reduce((sum, level) => sum + level.cols * level.rows, 0);
  return `Teselas en ${levels.length} ${levels.length === 1 ? "nivel" : "niveles"} (${tiles} en total) e imagen de respaldo de ${manifest.image.width} px`;
}

/** The status line under a card, in plain words. */
export function panoramaDetail(card: PanoramaCard): string {
  switch (card.status) {
    case "uploading":
      return "La subida no terminó. Si cerraste la página, vuelve a subir la foto.";
    case "processing": {
      const job = card.job;
      if (job?.status === "dead_letter") {
        return `No se pudo procesar tras ${job.attempts} intentos. El equipo de la plataforma puede reintentarlo desde «Trabajos en segundo plano».`;
      }
      if (job && job.attempts > 0 && job.status === "pending") {
        return `Hubo un problema pasajero; se reintenta solo (intento ${job.attempts + 1} de ${job.maxAttempts}).`;
      }
      return "Preparando las versiones para el visor. Puedes cerrar esta página: sigue en segundo plano.";
    }
    case "ready":
      return card.manifest ? deliveryLabel(card.manifest) : "Listo.";
    case "rejected":
      return PANORAMA_PROBLEMS[card.problem ?? "unreadable"];
  }
}
