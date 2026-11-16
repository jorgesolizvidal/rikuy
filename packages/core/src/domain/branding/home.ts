import type { ModuleKey } from "../tenancy/modules";

/**
 * The portal's home as data of the municipality (C3 · Paso 3, ADR-062): a cover, up to two
 * figures written by the municipality and the sections that follow, in order and in one of
 * the variants the platform offers. The keys and variants are fixed values; the database
 * re-checks them (`private.is_valid_home`). Nothing the municipality writes becomes markup,
 * CSS or a link.
 */

export const HERO_VARIANTS = ["text", "photo"] as const;
export type HeroVariant = (typeof HERO_VARIANTS)[number];

export const HOME_SECTION_KEYS = [
  "figures",
  "destinations",
  "events",
  "tours",
  "passport",
  "assistant",
] as const;
export type HomeSectionKey = (typeof HOME_SECTION_KEYS)[number];

export const HOME_LIMITS = {
  figures: 2,
  figureValue: 12,
  figureLabel: 60,
  sections: HOME_SECTION_KEYS.length,
} as const;

export interface HomeVariantInfo {
  readonly key: string;
  readonly name: string;
  readonly description: string;
}

export interface HomeSectionInfo {
  readonly key: HomeSectionKey;
  readonly name: string;
  readonly description: string;
  /** The first one is the default. */
  readonly variants: readonly HomeVariantInfo[];
  /** Shown only when the municipality has this module (ADR-060). */
  readonly module?: ModuleKey;
}

export const HERO_VARIANT_INFO: readonly HomeVariantInfo[] = [
  {
    key: "photo",
    name: "Con foto",
    description:
      "La foto de un destino junto al nombre del portal (en el tema Inmersivo, de fondo), con un enlace a su ficha. Sin foto publicada, se usa la portada de texto.",
  },
  {
    key: "text",
    name: "Solo texto",
    description: "El nombre del portal, su lema y su descripción, sin foto.",
  },
];

export const HOME_SECTIONS: readonly HomeSectionInfo[] = [
  {
    key: "figures",
    name: "Cifras",
    description:
      "Lo que el portal cuenta solo (lugares, recorridos 360°, eventos, circuitos) y hasta 2 cifras escritas por el municipio.",
    variants: [{ key: "band", name: "Franja", description: "Una franja del color del municipio." }],
  },
  {
    key: "destinations",
    name: "Lugares para visitar",
    description: "Las fichas de los destinos publicados.",
    variants: [
      { key: "grid", name: "Cuadrícula", description: "Tarjetas del mismo tamaño." },
      {
        key: "featured",
        name: "Uno destacado",
        description: "El primero más grande y el resto en tarjetas.",
      },
    ],
  },
  {
    key: "events",
    name: "Próximos eventos",
    description: "Los próximos eventos de la agenda.",
    module: "agenda",
    variants: [
      { key: "list", name: "Lista", description: "Fecha, nombre y lugar, en una lista." },
      { key: "cards", name: "Tarjetas con foto", description: "La foto del evento con su fecha." },
    ],
  },
  {
    key: "tours",
    name: "Recorridos 360°",
    description: "Una invitación al recorrido general, cuando hay tours publicados.",
    module: "tours",
    variants: [{ key: "banner", name: "Franja", description: "Una franja con enlace." }],
  },
  {
    key: "passport",
    name: "Pasaporte turístico",
    description: "Los circuitos y los sellos que ya tiene el visitante en su teléfono.",
    module: "passport",
    variants: [{ key: "banner", name: "Franja", description: "Una franja con enlace." }],
  },
  {
    key: "assistant",
    name: "Asistente",
    description: "Una invitación a preguntar al asistente del portal.",
    module: "assistant",
    variants: [{ key: "banner", name: "Franja", description: "Una franja con un botón." }],
  },
];

export const HOME_SECTION_INFO: Readonly<Record<HomeSectionKey, HomeSectionInfo>> =
  Object.fromEntries(HOME_SECTIONS.map((section) => [section.key, section])) as Record<
    HomeSectionKey,
    HomeSectionInfo
  >;

/** The variants each section accepts (the database has the same list). */
export function isHomeVariant(key: HomeSectionKey, variant: string): boolean {
  return HOME_SECTION_INFO[key].variants.some((option) => option.key === variant);
}

export interface HomeFigure {
  readonly value: string;
  readonly label: string;
}

export interface HomeSection {
  readonly key: HomeSectionKey;
  readonly variant: string;
}

export interface HomeLayout {
  readonly hero: { readonly variant: HeroVariant; readonly destinationId: string | null };
  readonly figures: readonly HomeFigure[];
  readonly sections: readonly HomeSection[];
}

/**
 * Sections a brand turns on itself (C3 · Paso 8, ADR-067): the figures band repeated what the
 * lists below already count, and the assistant has its own button on every page.
 */
const OPT_IN_SECTIONS: readonly HomeSectionKey[] = ["figures", "assistant"];

/**
 * The platform's home when a brand has none: the photo of the first destination that has
 * one and the catalog's sections in its order and default variant, without the opt-in ones.
 */
export const DEFAULT_HOME: HomeLayout = {
  hero: { variant: "photo", destinationId: null },
  figures: [],
  sections: HOME_SECTIONS.filter((section) => !OPT_IN_SECTIONS.includes(section.key)).map(
    (section) => ({ key: section.key, variant: section.variants[0]?.key ?? "" }),
  ),
};

/** The sections this municipality can show (its modules), in its order. */
export function visibleHomeSections(
  home: HomeLayout,
  has: (module: ModuleKey) => boolean,
): readonly HomeSection[] {
  return home.sections.filter((section) => {
    const module = HOME_SECTION_INFO[section.key].module;
    return module === undefined || has(module);
  });
}

/** What the portal counts by itself, for the figures band. */
export interface PortalCounts {
  readonly destinations: number;
  readonly tours: number;
  readonly events: number;
  readonly circuits: number;
}

/** What a figure in the band counts: the portal's own counts link to their section. */
export type FigureKind = "own" | "destinations" | "tours" | "events" | "circuits";

/** A figure of the band, with what it counts (its icon and its link, ADR-068). */
export interface BandFigure extends HomeFigure {
  readonly kind: FigureKind;
}

/** At most four figures in the band. */
export const FIGURES_IN_BAND = 4;

/**
 * The figures band: the municipality's own figures first, then what the portal counts (only
 * what it has: never a zero, never a module it does not have). Up to four.
 */
export function homeFigures(
  own: readonly HomeFigure[],
  counts: PortalCounts,
  has: (module: ModuleKey) => boolean,
): readonly BandFigure[] {
  const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);
  const counted: BandFigure[] = [
    ...(counts.destinations > 0
      ? [
          {
            kind: "destinations" as const,
            value: String(counts.destinations),
            label: plural(counts.destinations, "Lugar para visitar", "Lugares para visitar"),
          },
        ]
      : []),
    ...(counts.tours > 0 && has("tours")
      ? [
          {
            kind: "tours" as const,
            value: String(counts.tours),
            label: plural(counts.tours, "Recorrido 360°", "Recorridos 360°"),
          },
        ]
      : []),
    ...(counts.events > 0 && has("agenda")
      ? [
          {
            kind: "events" as const,
            value: String(counts.events),
            label: plural(counts.events, "Evento próximo", "Eventos próximos"),
          },
        ]
      : []),
    ...(counts.circuits > 0 && has("passport")
      ? [
          {
            kind: "circuits" as const,
            value: String(counts.circuits),
            label: plural(counts.circuits, "Circuito con premio", "Circuitos con premio"),
          },
        ]
      : []),
  ];
  return [
    ...own.map((figure) => ({ kind: "own" as const, value: figure.value, label: figure.label })),
    ...counted,
  ].slice(0, FIGURES_IN_BAND);
}

/** One entry of the phone's bottom bar. */
export type BottomBarKey = "home" | "destinations" | "agenda" | "passport" | "map" | "tours";

export interface BottomBarItem {
  readonly key: BottomBarKey;
  readonly label: string;
}

/** What the portal has: modules and, for tours and the passport, something published. */
export interface PortalSections {
  readonly agenda: boolean;
  readonly map: boolean;
  readonly tours: boolean;
  readonly passport: boolean;
}

/** Room in the bar; with more, the last place is «Más». */
export const BOTTOM_BAR_SIZE = 5;

/**
 * The phone's bottom bar, by what the municipality has (decided with the user: no
 * configuration). Always «Inicio» and «Destinos», then the 360° tours, the agenda and the
 * passport (C3 · Paso 8, ADR-067). The map is reached from «Destinos» (its list links to it),
 * so it takes a place only when the bar has room: with all five, nothing goes into «Más».
 */
export function bottomBar(sections: PortalSections): {
  readonly items: readonly BottomBarItem[];
  readonly more: readonly BottomBarItem[];
} {
  const main: BottomBarItem[] = [
    { key: "home", label: "Inicio" },
    { key: "destinations", label: "Destinos" },
    ...(sections.tours ? [{ key: "tours" as const, label: "360°" }] : []),
    ...(sections.agenda ? [{ key: "agenda" as const, label: "Agenda" }] : []),
    ...(sections.passport ? [{ key: "passport" as const, label: "Pasaporte" }] : []),
  ];
  const all =
    sections.map && main.length < BOTTOM_BAR_SIZE
      ? [...main, { key: "map" as const, label: "Mapa" }]
      : main;
  if (all.length <= BOTTOM_BAR_SIZE) return { items: all, more: [] };
  return { items: all.slice(0, BOTTOM_BAR_SIZE - 1), more: all.slice(BOTTOM_BAR_SIZE - 1) };
}
