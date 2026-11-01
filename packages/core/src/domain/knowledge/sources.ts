import { z } from "zod";

import { eventScheduleSchema } from "../../contracts/event";
import { documentManifestSchema, type DocumentText } from "../../contracts/knowledge";
import { richTextSchema } from "../../contracts/rich-text";
import { tourManifestSchema } from "../../contracts/tour";
import { formatEventSchedule } from "../events/schedule";
import { paragraph, richTextBlocks, type ChunkUnit } from "./chunker";
import { textBlocks } from "./text";

/**
 * What the indexer reads about a sealed revision (worker_api.knowledge_source), and the
 * units it is cut into: a content item is one unit (its document's sections inside), a tour
 * is one unit per scene and one per point with text.
 */

export const contentIndexSourceSchema = z.object({
  source: z.literal("content"),
  kind: z.enum(["destination", "event", "knowledge"]),
  slug: z.string(),
  revisionNo: z.number().int().min(1),
  title: z.string().min(1),
  summary: z.string(),
  body: richTextSchema.catch([]),
  timezone: z.string(),
  schedule: eventScheduleSchema.nullable().catch(null),
  venueTitle: z.string().nullable(),
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

/** The units of a content revision: summary, the event's date and place, text, document. */
export function contentUnits(
  source: ContentIndexSource,
  document: DocumentText | null,
): ChunkUnit[] {
  const facts: string[] = [];
  if (source.kind === "event" && source.schedule) {
    facts.push(`Fecha: ${formatEventSchedule(source.schedule)}.`);
  }
  if (source.kind === "event" && source.venueTitle) facts.push(`Lugar: ${source.venueTitle}.`);
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
