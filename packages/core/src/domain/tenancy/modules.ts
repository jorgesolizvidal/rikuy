/**
 * The modules a municipality has (C3 · Paso 1, ADR-060). Destinations and the panel's own
 * pages (brand, members, statistics, usage, monthly report) are always there; everything
 * else is a module the platform operator turns on or off. Turning one off hides it in the
 * portal and the panel and deletes nothing. The catalog's keys live in the database too
 * (`platform_modules`); the names and descriptions live here.
 */

export const MODULE_KEYS = [
  "agenda",
  "map",
  "tours",
  "models",
  "passport",
  "assistant",
  "voice",
  "copilot",
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

export interface ModuleInfo {
  readonly key: ModuleKey;
  readonly name: string;
  /** What visitors and the team get with it. */
  readonly description: string;
  /** Needs this other module on. */
  readonly requires?: ModuleKey;
}

export const MODULES: readonly ModuleInfo[] = [
  {
    key: "agenda",
    name: "Agenda",
    description: "Eventos con fecha y lugar, y «Añadir al calendario».",
  },
  {
    key: "map",
    name: "Mapa",
    description: "El mapa del portal y el mapa pequeño de cada ficha.",
  },
  {
    key: "tours",
    name: "Tours 360°",
    description: "Panoramas 360°, tours de los destinos y eventos, y el recorrido general.",
  },
  {
    key: "models",
    name: "Modelos 3D",
    description: "Objetos en 3D dentro de los tours.",
    requires: "tours",
  },
  {
    key: "passport",
    name: "Pasaporte turístico",
    description: "Circuitos con sellos QR en cada lugar y un premio.",
  },
  {
    key: "assistant",
    name: "Asistente del visitante",
    description: "Responde preguntas con lo publicado; su conocimiento y lo que no supo responder.",
  },
  {
    key: "voice",
    name: "Voz del asistente",
    description: "Dictar la pregunta y escuchar la respuesta.",
    requires: "assistant",
  },
  {
    key: "copilot",
    name: "Copilot",
    description: "Revisa el contenido, propone textos y recomienda con las estadísticas.",
  },
];

export const MODULE_NAMES: Readonly<Record<ModuleKey, string>> = Object.fromEntries(
  MODULES.map((module) => [module.key, module.name]),
) as Record<ModuleKey, string>;

/** Packages the operator chooses from when provisioning a municipality. */
export const MODULE_PACKAGES = {
  complete: MODULE_KEYS,
  information: ["agenda", "map"],
} as const satisfies Record<string, readonly ModuleKey[]>;

export type ModulePackage = keyof typeof MODULE_PACKAGES;

export const MODULE_PACKAGE_NAMES: Readonly<Record<ModulePackage, string>> = {
  complete: "Completo",
  information: "Solo información",
};

export function isModuleKey(value: unknown): value is ModuleKey {
  return typeof value === "string" && (MODULE_KEYS as readonly string[]).includes(value);
}

/**
 * Whether a municipality has a module. An unknown set (an app deployed before the
 * migration of ADR-060) means everything, as before.
 */
export function hasModule(modules: readonly ModuleKey[] | undefined, key: ModuleKey): boolean {
  return modules === undefined || modules.includes(key);
}

export type ModuleSetResult =
  | { readonly status: "ok"; readonly modules: readonly ModuleKey[] }
  | { readonly status: "invalid" }
  /** A module that needs another one that is not in the set. */
  | { readonly status: "requires"; readonly module: ModuleKey; readonly needs: ModuleKey };

/** A requested set: known keys, each once, every requirement in it; in the catalog's order. */
export function checkModuleSet(values: readonly unknown[]): ModuleSetResult {
  if (!values.every(isModuleKey)) return { status: "invalid" };
  if (new Set(values).size !== values.length) return { status: "invalid" };
  const chosen = new Set<ModuleKey>(values);
  for (const module of MODULES) {
    if (chosen.has(module.key) && module.requires && !chosen.has(module.requires)) {
      return { status: "requires", module: module.key, needs: module.requires };
    }
  }
  return { status: "ok", modules: MODULE_KEYS.filter((key) => chosen.has(key)) };
}

/**
 * Whether the assistant may read a passage of the knowledge base: never one of a tour when
 * the tours are off, nor one of an event without the agenda. Its text is published, so this
 * keeps the portal coherent rather than secret: what the portal does not show, the
 * assistant does not offer.
 */
export function passageVisibleWith(
  modules: readonly ModuleKey[] | undefined,
  passage: { readonly source: "content" | "tour"; readonly kind: string },
): boolean {
  if (passage.source === "tour" && !hasModule(modules, "tours")) return false;
  if (passage.kind === "event" && !hasModule(modules, "agenda")) return false;
  return true;
}

/** A membership only if its municipality has the module (ADR-060): actions of that module. */
export function withModule<T extends { readonly modules?: readonly ModuleKey[] | undefined }>(
  membership: T | null,
  key: ModuleKey,
): T | null {
  return membership !== null && hasModule(membership.modules, key) ? membership : null;
}
