/**
 * The modules a municipality has (C3 · Paso 1, ADR-060). Destinations and the panel's own
 * pages (brand, members, statistics, usage, monthly report) are always there; everything
 * else is a module the platform operator turns on or off. Turning one off hides it in the
 * portal and the panel and deletes nothing. The catalog's keys live in the database too
 * (`platform_modules`); the names and descriptions live here.
 */

export const MODULE_KEYS = [
  "portal",
  "agenda",
  "map",
  "tours",
  "models",
  "passport",
  "assistant",
  "voice",
  "copilot",
  "services",
  "community_memory",
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
    key: "portal",
    name: "Portal público",
    description:
      "Las páginas del municipio para visitantes: inicio, destinos, fichas y más. Sin él, solo el asistente, en su web y por QR.",
  },
  {
    key: "agenda",
    name: "Agenda",
    description: "Eventos con fecha y lugar, y «Añadir al calendario».",
  },
  {
    key: "map",
    name: "Mapa",
    description: "El mapa del portal y el mapa pequeño de cada ficha.",
    requires: "portal",
  },
  {
    key: "tours",
    name: "Tours 360°",
    description: "Panoramas 360°, tours de los destinos y eventos, y el recorrido general.",
    requires: "portal",
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
    requires: "portal",
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
  {
    key: "services",
    name: "Servicios locales",
    description: "Dónde comer, dormir, sacar dinero o tomar transporte, con horario y contacto.",
  },
  {
    key: "community_memory",
    name: "Memoria de la comunidad",
    description:
      "Relatos de los vecinos, con su autor y su consentimiento, que el asistente cuenta atribuidos.",
  },
];

export const MODULE_NAMES: Readonly<Record<ModuleKey, string>> = Object.fromEntries(
  MODULES.map((module) => [module.key, module.name]),
) as Record<ModuleKey, string>;

/** Packages the operator chooses from when provisioning a municipality. */
export const MODULE_PACKAGES = {
  complete: MODULE_KEYS,
  information: ["portal", "agenda", "map", "services", "community_memory"],
  /** For a municipality with its own website (ADR-071): the assistant and what it knows. */
  assistant_only: ["agenda", "assistant", "voice", "copilot", "services", "community_memory"],
} as const satisfies Record<string, readonly ModuleKey[]>;

export type ModulePackage = keyof typeof MODULE_PACKAGES;

export const MODULE_PACKAGE_NAMES: Readonly<Record<ModulePackage, string>> = {
  complete: "Completo",
  information: "Solo información",
  assistant_only: "Solo asistente",
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
 * the tours are off, nor one of an event without the agenda, nor a service or a story without
 * its module. Its text is published, so this
 * keeps the portal coherent rather than secret: what the portal does not show, the
 * assistant does not offer.
 */
export function passageVisibleWith(
  modules: readonly ModuleKey[] | undefined,
  passage: { readonly source: "content" | "tour"; readonly kind: string },
): boolean {
  if (passage.source === "tour" && !hasModule(modules, "tours")) return false;
  if (passage.kind === "event" && !hasModule(modules, "agenda")) return false;
  if (passage.kind === "service" && !hasModule(modules, "services")) return false;
  if (passage.kind === "story" && !hasModule(modules, "community_memory")) return false;
  return true;
}

/** A membership only if its municipality has the module (ADR-060): actions of that module. */
export function withModule<T extends { readonly modules?: readonly ModuleKey[] | undefined }>(
  membership: T | null,
  key: ModuleKey,
): T | null {
  return membership !== null && hasModule(membership.modules, key) ? membership : null;
}

/**
 * What a municipality without its public portal still serves (ADR-071): the assistant's pages
 * and calls, the legal pages, the icons and the manifest, robots.txt and the visit counts.
 * Everything else answers its 404; the home leads to the assistant's page.
 */
const WITHOUT_PORTAL = [
  /^\/preguntar(?:\/|$)/u,
  /^\/insertar(?:\/|$)/u,
  /^\/asistente(?:\/|$)/u,
  /^\/(?:privacidad|terminos|robots\.txt|manifest\.webmanifest|visita)$/u,
  /^\/icon(?:\/|$)/u,
];

export type PortalPathAccess = "open" | "home" | "closed";

/** Whether a path of a portal host is served, given the municipality's modules. */
export function portalPathAccess(
  modules: readonly ModuleKey[] | undefined,
  pathname: string,
): PortalPathAccess {
  if (hasModule(modules, "portal")) return "open";
  if (pathname === "/" || pathname === "") return "home";
  return WITHOUT_PORTAL.some((pattern) => pattern.test(pathname)) ? "open" : "closed";
}
