import { MODEL_LIMITS, type ModelCard, type ModelProblem } from "@rikuy/core";

const MB = 1024 * 1024;
const NUMBER = new Intl.NumberFormat("es-BO", { maximumFractionDigits: 1 });
const INTEGER = new Intl.NumberFormat("es-BO");

export const MODEL_HINT = `Un archivo .glb (glTF binario, con texturas incluidas) de hasta ${MODEL_LIMITS.maxBytes / MB} MB. El original se guarda tal cual; la copia optimizada para celulares se prepara sola y se revisa que conserve los colores.`;

export const MODEL_PROBLEMS: Readonly<Record<ModelProblem, string>> = {
  unsupported_type:
    "Sube un archivo .glb. Si tienes un .gltf con archivos aparte, expórtalo como .glb con todo incluido.",
  too_heavy: `El archivo pesa más de ${MODEL_LIMITS.maxBytes / MB} MB.`,
  not_glb: "El archivo no es un GLB válido. Expórtalo de nuevo como glTF binario (.glb).",
  invalid_model:
    "El modelo tiene errores de formato según el validador oficial de glTF. Expórtalo de nuevo.",
  external_files:
    "El modelo usa archivos externos (texturas o datos aparte). Expórtalo como .glb con todo incluido.",
  unsupported_extension: "El modelo necesita una extensión de glTF que el visor no admite.",
  too_complex: `Es demasiado complejo para un celular: más de ${INTEGER.format(MODEL_LIMITS.maxTriangles)} triángulos o ${MODEL_LIMITS.maxTextures} texturas. Simplifícalo y vuelve a subirlo.`,
  too_heavy_optimized: `Aun optimizado pesa más de ${MODEL_LIMITS.maxOptimizedBytes / MB} MB: reduce las texturas o la geometría y vuelve a subirlo.`,
  colors_changed:
    "La optimización cambiaba sus colores, así que no se usó. Avisa al equipo de la plataforma para revisarlo.",
  unreadable: "No pudimos leer el modelo (puede estar dañado). Prueba exportarlo de nuevo.",
};

export const MODEL_STATUS: Readonly<Record<ModelCard["status"], string>> = {
  uploading: "Subiendo",
  processing: "Optimizando",
  ready: "Listo",
  rejected: "Rechazado",
};

export function formatMegabytes(bytes: number): string {
  return `${NUMBER.format(bytes / MB)} MB`;
}

export function formatCount(value: number): string {
  return INTEGER.format(value);
}

export function formatDelta(value: number): string {
  return NUMBER.format(value);
}

/** The status line under a card that is not ready, in plain words. */
export function pendingDetail(card: ModelCard): string {
  switch (card.status) {
    case "uploading":
      return "La subida no terminó. Si cerraste la página, vuelve a subir el archivo.";
    case "processing": {
      const job = card.job;
      if (job?.status === "dead_letter") {
        return `No se pudo procesar tras ${job.attempts} intentos. El equipo de la plataforma puede reintentarlo desde «Trabajos en segundo plano».`;
      }
      if (job && job.attempts > 0 && job.status === "pending") {
        return `Hubo un problema pasajero; se reintenta solo (intento ${job.attempts + 1} de ${job.maxAttempts}).`;
      }
      return "Validando y optimizando el modelo. Puedes cerrar esta página: sigue en segundo plano.";
    }
    case "rejected":
      return MODEL_PROBLEMS[card.problem ?? "unreadable"];
    case "ready":
      return "";
  }
}

/** How the textures were kept: "12 en KTX2" / "10 en KTX2, 2 como el original". */
export function texturesSummary(card: ModelCard): string {
  const textures = card.manifest?.model.textures ?? [];
  if (textures.length === 0) return "Sin texturas";
  const ktx2 = textures.filter((texture) => texture.encoding !== "original").length;
  const kept = textures.length - ktx2;
  const parts = [
    ktx2 > 0 ? `${ktx2} en KTX2` : null,
    kept > 0 ? `${kept} como en el original` : null,
  ].filter(Boolean);
  return `${textures.length} ${textures.length === 1 ? "textura" : "texturas"}: ${parts.join(", ")}`;
}

/** The largest color drift of the compressed color textures (ΔE), or null. */
export function worstColorDrift(card: ModelCard): number | null {
  const checks = (card.manifest?.model.textures ?? [])
    .filter((texture) => texture.usage === "color" && texture.check)
    .map((texture) => texture.check?.mean ?? 0);
  const vertex = card.manifest?.colors.vertexColors?.mean;
  const all = vertex === undefined ? checks : [...checks, vertex];
  return all.length === 0 ? null : Math.max(...all);
}
