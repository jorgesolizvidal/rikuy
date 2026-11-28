import { z } from "zod";

import { openingHoursSchema } from "../../contracts/destination";
import { eventScheduleSchema } from "../../contracts/event";
import { documentManifestSchema, type DocumentText } from "../../contracts/knowledge";
import { FAQ_TOPIC_NAMES, FAQ_TOPICS } from "../../contracts/faq";
import { noticeValiditySchema } from "../../contracts/notice";
import { richTextSchema } from "../../contracts/rich-text";
import { SERVICE_CATEGORIES } from "../../contracts/service";
import { storyTeller } from "../../contracts/story";
import { tourManifestSchema } from "../../contracts/tour";
import { formatEventSchedule } from "../events/schedule";
import { formatMinutes } from "../geo/proximity";
import { describeNoticeValidity } from "../notices/validity";
import { openingHoursText } from "../plan/hours";
import { SERVICE_CATEGORY_INFO } from "../services/categories";
import { paragraph, richTextBlocks, type ChunkUnit } from "./chunker";
import { textBlocks } from "./text";

/**
 * What the indexer reads about a sealed revision (worker_api.knowledge_source), and the
 * units it is cut into: a content item is one unit (its document's sections inside), a tour
 * is one unit per scene and one per point with text.
 */

export const contentIndexSourceSchema = z.object({
  source: z.literal("content"),
  kind: z.enum(["destination", "event", "knowledge", "notice", "service", "story", "faq"]),
  slug: z.string(),
  revisionNo: z.number().int().min(1),
  title: z.string().min(1),
  summary: z.string(),
  body: richTextSchema.catch([]),
  timezone: z.string(),
  schedule: eventScheduleSchema.nullable().catch(null),
  /** A destination's opening hours (ADR-039); absent before P5 · Paso 4. */
  hours: openingHoursSchema.nullable().catch(null).default(null),
  venueTitle: z.string().nullable(),
  /** A notice's validity and place (ADR-069); absent before A · Paso 1.1. */
  validity: noticeValiditySchema.nullable().catch(null).default(null),
  placeTitle: z.string().nullable().catch(null).default(null),
  /** A service's category, contact and address (ADR-069); absent before A · Paso 1.2. */
  service: z
    .object({
      category: z.enum(SERVICE_CATEGORIES).nullable(),
      phone: z.string().nullable(),
      whatsapp: z.string().nullable(),
      address: z.string().nullable(),
    })
    .nullable()
    .catch(null)
    .default(null),
  /** A destination's visit time and «for children» (ADR-072); absent before A · Paso 3. */
  visitMinutes: z.number().int().positive().nullable().catch(null).default(null),
  kids: z.boolean().nullable().catch(null).default(null),
  /** Who tells a story and their community (ADR-069); absent before A · Paso 1.3. */
  story: z
    .object({
      author: z.string().nullable(),
      anonymous: z.boolean(),
      community: z.string().nullable(),
    })
    .nullable()
    .catch(null)
    .default(null),
  /** A question's topic (ADR-074); absent before A · Paso 5.2. */
  faq: z
    .object({ topic: z.enum(FAQ_TOPICS).nullable() })
    .nullable()
    .catch(null)
    .default(null),
  document: z.object({ prefix: z.string(), manifest: documentManifestSchema }).nullable(),
});

export const tourIndexSourceSchema = z.object({
  source: z.literal("tour"),
  kind: z.enum(["destination", "event"]),
  slug: z.string(),
  revisionNo: z.number().int().min(1),
  title: z.string().min(1),
  manifest: tourManifestSchema,
});

export const indexSourceSchema = z.discriminatedUnion("source", [
  contentIndexSourceSchema,
  tourIndexSourceSchema,
]);

export type IndexSource = z.infer<typeof indexSourceSchema>;
export type ContentIndexSource = z.infer<typeof contentIndexSourceSchema>;

/**
 * The units of a content revision: summary, the event's date and place (or the notice's
 * validity and place, or the service's category, address, contact and hours), text, document.
 */
export function contentUnits(
  source: ContentIndexSource,
  document: DocumentText | null,
): ChunkUnit[] {
  const facts: string[] = [];
  if (source.kind === "event" && source.schedule) {
    facts.push(`Fecha: ${formatEventSchedule(source.schedule)}.`);
  }
  if (source.kind === "event" && source.venueTitle) facts.push(`Lugar: ${source.venueTitle}.`);
  if (source.kind === "notice" && source.validity) {
    const validity = describeNoticeValidity(source.validity);
    if (validity)
      facts.push(`Aviso vigente ${validity.charAt(0).toLowerCase()}${validity.slice(1)}.`);
  }
  if (source.kind === "notice" && source.placeTitle) facts.push(`Lugar: ${source.placeTitle}.`);
  if (source.kind === "service" && source.service) {
    // The category in words, so «¿hay un cajero?» finds the card (ADR-069).
    facts.push(SERVICE_CATEGORY_INFO[source.service.category ?? "other"].words);
    if (source.service.address) facts.push(`Dirección: ${source.service.address}.`);
    if (source.service.phone) facts.push(`Teléfono: ${source.service.phone}.`);
    if (source.service.whatsapp) facts.push(`WhatsApp: ${source.service.whatsapp}.`);
  }
  if (source.kind === "story" && source.story) {
    // Whose story it is goes first, so every passage says it (ADR-069).
    const teller = storyTeller(source.story);
    facts.push(
      teller === "Anónimo"
        ? "Relato anónimo de la comunidad."
        : `Relato de ${teller}${source.story.community ? ` (${source.story.community})` : ""}.`,
    );
    if (source.placeTitle) facts.push(`Lugar: ${source.placeTitle}.`);
  }
  if (source.kind === "faq") {
    // The question is the title and the answer the summary: say what it is (ADR-074).
    const topic = FAQ_TOPIC_NAMES[source.faq?.topic ?? "other"];
    facts.push(`Pregunta frecuente del municipio (${topic.toLowerCase()}).`);
    if (source.placeTitle) facts.push(`Lugar: ${source.placeTitle}.`);
  }
  if ((source.kind === "destination" || source.kind === "service") && source.hours) {
    facts.push(`Horario de atención: ${openingHoursText(source.hours)}.`);
  }
  // «¿Se puede ir con niños?», «¿cuánto tiempo se necesita?» (ADR-072).
  if (source.kind === "destination" || source.kind === "event") {
    if (source.kids === true) facts.push("Apto para ir con niños.");
    if (source.kids === false) facts.push("No es recomendable para ir con niños.");
  }
  if (source.kind === "destination" && source.visitMinutes !== null) {
    facts.push(`Tiempo de visita sugerido: ${formatMinutes(source.visitMinutes)}.`);
  }
  const blocks = [
    ...(source.summary.trim() !== "" ? [paragraph(source.summary)] : []),
    ...(facts.length > 0 ? [paragraph(facts.join(" "))] : []),
    ...richTextBlocks(source.body),
    ...(document ? textBlocks(document.pages) : []),
  ];
  return [{ heading: null, sceneId: null, hotspotId: null, blocks }];
}

/** The units of a tour revision: each scene, then each point with text. */
export function tourUnits(source: z.infer<typeof tourIndexSourceSchema>): ChunkUnit[] {
  const units: ChunkUnit[] = [];
  for (const scene of source.manifest.scenes) {
    if (scene.description.trim() !== "") {
      units.push({
        heading: scene.title,
        sceneId: scene.sceneId,
        hotspotId: null,
        blocks: [paragraph(scene.description)],
      });
    }
    for (const hotspot of scene.hotspots) {
      if (hotspot.kind !== "info" && hotspot.kind !== "model") continue;
      const blocks = richTextBlocks(hotspot.body);
      if (blocks.length === 0) continue;
      units.push({
        heading: `${scene.title} · ${hotspot.title}`,
        sceneId: scene.sceneId,
        hotspotId: hotspot.hotspotId,
        blocks,
      });
    }
  }
  return units;
}
