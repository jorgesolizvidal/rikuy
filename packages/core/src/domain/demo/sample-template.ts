import type { GeoPoint } from "../../contracts/destination";

/**
 * The sample content of a commercial demo (ADR-034): generic places and events of no real
 * municipality, written so they read well for any of them. `{municipio}` is replaced with
 * the demo's own name. Every body starts by saying it is sample text, so whoever edits the
 * demo knows what to replace.
 */

/** What the illustration of an item shows (the renderer draws it; no photo of a real place). */
export type SampleScene =
  "plaza" | "mirador" | "museo" | "mercado" | "rio" | "feria" | "festival" | "caminata";

export interface SampleDestination {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  /** Limited Markdown of the editor (`## título`, `- lista`, `**negrita**`, `*cursiva*`). */
  readonly body: string;
  /** Meters from the center the operator gives (north and east). */
  readonly offset: { readonly north: number; readonly east: number };
  readonly scene: SampleScene;
  readonly alt: string;
  readonly galleryAlt: string;
}

export interface SampleEvent {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  /** Days from today to the first day it may fall on; it moves to the next `weekday`. */
  readonly inDays: number;
  /** 0 Sunday … 6 Saturday. */
  readonly weekday: number;
  readonly start: string;
  readonly end: string;
  readonly venue: string;
  readonly scene: SampleScene;
  readonly alt: string;
}

const NOTE = "*Texto de muestra: reemplázalo con la historia y los datos reales de este lugar.*";
const EVENT_NOTE = "*Texto de muestra: reemplázalo con el programa real del evento.*";

export const SAMPLE_DESTINATIONS: readonly SampleDestination[] = [
  {
    slug: "plaza-principal",
    title: "Plaza principal",
    summary: "El corazón de {municipio}: punto de encuentro, ferias y celebraciones todo el año.",
    body: [
      NOTE,
      "La plaza principal reúne la vida de {municipio}. Alrededor están los edificios más antiguos, los cafés y las tiendas de artesanía.",
      "## Qué hacer",
      "- Recorrer las calles que salen de la plaza",
      "- Probar la comida de los puestos del domingo",
      "- Empezar aquí el **recorrido 360°**",
    ].join("\n\n"),
    offset: { north: 0, east: 0 },
    scene: "plaza",
    alt: "Ilustración de muestra: plaza con edificios bajos y montañas al fondo",
    galleryAlt: "Ilustración de muestra: la plaza al atardecer",
  },
  {
    slug: "mirador-del-valle",
    title: "Mirador del valle",
    summary: "La mejor vista de {municipio} y del valle, a una caminata corta del centro.",
    body: [
      NOTE,
      "Desde el mirador se ve todo el valle. Al amanecer y al atardecer la luz es la más bonita.",
      "## Antes de ir",
      "- Lleva agua y abrigo: arriba sopla el viento",
      "- El camino es de tierra; usa calzado cómodo",
    ].join("\n\n"),
    offset: { north: 900, east: 700 },
    scene: "mirador",
    alt: "Ilustración de muestra: vista del valle desde un mirador",
    galleryAlt: "Ilustración de muestra: cerros y nubes desde el mirador",
  },
  {
    slug: "museo-comunitario",
    title: "Museo comunitario",
    summary: "La historia de {municipio} contada por su gente: objetos, fotos y oficios.",
    body: [
      NOTE,
      "El museo guarda herramientas, textiles y fotografías que las familias de {municipio} donaron a lo largo de los años.",
      "## Horario",
      "Martes a domingo, de 9:00 a 17:00.",
    ].join("\n\n"),
    offset: { north: 150, east: -250 },
    scene: "museo",
    alt: "Ilustración de muestra: edificio del museo con columnas",
    galleryAlt: "Ilustración de muestra: entrada del museo",
  },
  {
    slug: "mercado-central",
    title: "Mercado central",
    summary: "Frutas, quesos, pan y comida típica de {municipio}, de la mañana al mediodía.",
    body: [
      NOTE,
      "En el mercado se compra lo que producen las comunidades cercanas. Los domingos hay más puestos y música.",
      "## Para probar",
      "- El desayuno de los puestos de la entrada",
      "- Las frutas de temporada",
    ].join("\n\n"),
    offset: { north: -300, east: 200 },
    scene: "mercado",
    alt: "Ilustración de muestra: puestos del mercado con toldos de colores",
    galleryAlt: "Ilustración de muestra: pasillo del mercado",
  },
  {
    slug: "sendero-del-rio",
    title: "Sendero del río",
    summary: "Un paseo tranquilo junto al río, ideal para ir en familia o en bicicleta.",
    body: [
      NOTE,
      "El sendero sigue el río durante unos tres kilómetros, con sombra y lugares para descansar.",
      "## Consejos",
      "- Ve temprano para ver aves",
      "- Lleva tu basura de vuelta",
    ].join("\n\n"),
    offset: { north: -1200, east: -900 },
    scene: "rio",
    alt: "Ilustración de muestra: río entre árboles y cerros",
    galleryAlt: "Ilustración de muestra: orilla del río",
  },
];

export const SAMPLE_EVENTS: readonly SampleEvent[] = [
  {
    slug: "feria-gastronomica",
    title: "Feria gastronómica",
    summary: "Cocineras y cocineros de {municipio} preparan sus platos típicos en el mercado.",
    body: [EVENT_NOTE, "Puestos de comida, música en vivo y concurso del mejor plato."].join(
      "\n\n",
    ),
    inDays: 4,
    weekday: 6,
    start: "10:00",
    end: "18:00",
    venue: "mercado-central",
    scene: "feria",
    alt: "Ilustración de muestra: feria con banderines de colores",
  },
  {
    slug: "caminata-guiada-al-mirador",
    title: "Caminata guiada al mirador",
    summary: "Una caminata de dos horas con guías locales, para ver el valle al amanecer.",
    body: [
      EVENT_NOTE,
      "Salida desde la plaza principal. Cupos limitados; trae agua y abrigo.",
    ].join("\n\n"),
    inDays: 9,
    weekday: 0,
    start: "06:30",
    end: "09:00",
    venue: "mirador-del-valle",
    scene: "caminata",
    alt: "Ilustración de muestra: sendero que sube hacia los cerros",
  },
  {
    slug: "festival-de-musica",
    title: "Festival de música",
    summary: "Bandas y grupos de la región en la plaza principal de {municipio}.",
    body: [EVENT_NOTE, "Escenario en la plaza, comida y artesanía hasta la medianoche."].join(
      "\n\n",
    ),
    inDays: 18,
    weekday: 6,
    start: "19:00",
    end: "23:30",
    venue: "plaza-principal",
    scene: "festival",
    alt: "Ilustración de muestra: escenario con luces de noche",
  },
];

/** The destination whose tour the sample builds. */
export const SAMPLE_TOUR_DESTINATION = "plaza-principal";

/** The two panoramas of the sample tour, in order. */
export const SAMPLE_PANORAMAS: readonly { readonly scene: SampleScene; readonly title: string }[] =
  [
    { scene: "plaza", title: "Centro de la plaza" },
    { scene: "mirador", title: "Vista desde lo alto" },
  ];

export function fillSampleText(text: string, municipality: string): string {
  return text.replaceAll("{municipio}", municipality);
}

const METERS_PER_DEGREE = 111_320;

/** A point some meters north and east of another (good enough for a few kilometers). */
export function offsetPoint(center: GeoPoint, north: number, east: number): GeoPoint {
  const lat = center.lat + north / METERS_PER_DEGREE;
  const lng = center.lng + east / (METERS_PER_DEGREE * Math.cos((center.lat * Math.PI) / 180));
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  return {
    lat: Math.min(90, Math.max(-90, round(lat))),
    lng: round(((lng + 540) % 360) - 180),
  };
}

/** `YYYY-MM-DD` of the first `weekday` at least `inDays` days after `today` (UTC dates). */
export function sampleEventDate(today: Date, inDays: number, weekday: number): string {
  const base = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const first = new Date(base + inDays * 86_400_000);
  const shift = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(first.getTime() + shift * 86_400_000).toISOString().slice(0, 10);
}
