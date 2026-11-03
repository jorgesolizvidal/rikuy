import type { KnowledgePassage } from "@rikuy/core";
import { z } from "zod";

/**
 * A row of the knowledge search (private.search_knowledge, ADR-037), the same through the
 * member's session (search_tenant_knowledge) and the AI role (ai_api.search_knowledge).
 */
const passageRowSchema = z.object({
  chunk_id: z.uuid(),
  source: z.enum(["content", "tour"]),
  source_id: z.uuid(),
  source_version: z.number().int(),
  kind: z.enum(["destination", "event", "knowledge"]),
  slug: z.string(),
  title: z.string(),
  heading: z.string().nullable(),
  body: z.string(),
  page_from: z.number().int().nullable(),
  page_to: z.number().int().nullable(),
  scene_id: z.uuid().nullable(),
  hotspot_id: z.uuid().nullable(),
  ended: z.boolean(),
  score: z.number(),
});

export function mapPassageRow(raw: unknown): KnowledgePassage {
  const row = passageRowSchema.parse(raw);
  return {
    chunkId: row.chunk_id,
    source: row.source,
    sourceId: row.source_id,
    sourceVersion: row.source_version,
    kind: row.kind,
    slug: row.slug,
    title: row.title,
    heading: row.heading,
    text: row.body,
    pages:
      row.page_from !== null && row.page_to !== null
        ? { from: row.page_from, to: row.page_to }
        : null,
    sceneId: row.scene_id,
    hotspotId: row.hotspot_id,
    ended: row.ended,
    score: row.score,
  };
}
