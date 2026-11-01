import type {
  KnowledgeIndexEntry,
  KnowledgePassage,
  PublicCitation,
} from "../../contracts/knowledge";
import type { OrganizationMembership } from "../../contracts/organization";
import { TOUR_SCENE_QUERY } from "../../domain/tours/viewer";
import { PORTAL_PATHS, tourPath } from "../content/portal";
import type { KnowledgeRepository } from "./ports";

/** A question is at most this long (the database reads its first 500 characters). */
export const KNOWLEDGE_QUERY_MAX = 300;
/** Passages a search returns (the assistant gets the same number). */
export const KNOWLEDGE_RESULTS = 8;

export type KnowledgeSearchResult =
  | {
      readonly status: "ok";
      readonly query: string;
      readonly passages: readonly KnowledgePassage[];
    }
  | { readonly status: "invalid" };

/**
 * «Probar la búsqueda»: exactly what the assistant would find now, without the model (no
 * tokens). Any member may try it.
 */
export async function searchKnowledge(
  membership: OrganizationMembership,
  query: unknown,
  repository: KnowledgeRepository,
): Promise<KnowledgeSearchResult> {
  const text = typeof query === "string" ? query.replace(/\s+/gu, " ").trim() : "";
  if (text.length < 2 || text.length > KNOWLEDGE_QUERY_MAX || /\p{Cc}/u.test(text)) {
    return { status: "invalid" };
  }
  const passages = await repository.search(membership.tenantId, text, KNOWLEDGE_RESULTS);
  return { status: "ok", query: text, passages };
}

export interface KnowledgeOverview {
  readonly sources: readonly KnowledgeIndexEntry[];
  readonly indexed: number;
  readonly pending: number;
  readonly failed: number;
  readonly chunks: number;
}

/** What the assistant knows, source by source, and what is still being read. */
export async function loadKnowledgeOverview(
  membership: OrganizationMembership,
  repository: KnowledgeRepository,
): Promise<KnowledgeOverview> {
  const sources = await repository.indexStatus(membership.tenantId);
  let indexed = 0;
  let pending = 0;
  let failed = 0;
  let chunks = 0;
  for (const source of sources) {
    if (source.chunks !== null) {
      indexed += 1;
      chunks += source.chunks;
    } else if (source.job?.status === "dead_letter") failed += 1;
    else pending += 1;
  }
  return { sources, indexed, pending, failed, chunks };
}

const LABELS = { destination: "Destino", event: "Evento", knowledge: "Documento" } as const;

function pageLabel(pages: KnowledgePassage["pages"]): string | null {
  if (!pages) return null;
  return pages.from === pages.to ? `pág. ${pages.from}` : `págs. ${pages.from}–${pages.to}`;
}

/**
 * The citation as the visitor sees it: title (and section), page, and a link inside the
 * portal — the destination, the event or the tour on its scene. Documents are only for the
 * assistant: no link (ADR-037). Never an internal id.
 */
export function publicCitation(passage: KnowledgePassage): PublicCitation {
  const title = passage.heading ? `${passage.title} · ${passage.heading}` : passage.title;
  const common = { title, page: pageLabel(passage.pages), ended: passage.ended };
  if (passage.source === "tour" && passage.kind !== "knowledge") {
    const scene = passage.sceneId
      ? `?${TOUR_SCENE_QUERY}=${encodeURIComponent(passage.sceneId)}`
      : "";
    return { ...common, label: "Tour 360°", href: tourPath(passage.kind, passage.slug) + scene };
  }
  const href =
    passage.kind === "destination"
      ? PORTAL_PATHS.destination(passage.slug)
      : passage.kind === "event"
        ? PORTAL_PATHS.event(passage.slug)
        : null;
  return { ...common, label: LABELS[passage.kind], href };
}
