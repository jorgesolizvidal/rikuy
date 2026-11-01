import {
  knowledgeCitationSchema,
  type KnowledgeCitation,
  type KnowledgePassage,
} from "../../contracts/knowledge";

/**
 * Citations (D5, ADR-037): an answer may only cite passages that were retrieved for it, and
 * what the visitor sees of them is built by publicCitation (application/knowledge).
 */

export function citationOf(passage: KnowledgePassage): KnowledgeCitation {
  return {
    source: passage.source,
    sourceId: passage.sourceId,
    sourceVersion: passage.sourceVersion,
    chunkId: passage.chunkId,
  };
}

/**
 * Keeps the citations that name a retrieved passage exactly (source, version and chunk),
 * once each and in order; counts the ones that do not.
 */
export function validateCitations(
  citations: readonly unknown[],
  passages: readonly KnowledgePassage[],
): { readonly valid: readonly KnowledgePassage[]; readonly invalid: number } {
  const byChunk = new Map(passages.map((passage) => [passage.chunkId, passage]));
  const valid: KnowledgePassage[] = [];
  let invalid = 0;
  for (const raw of citations) {
    const parsed = knowledgeCitationSchema.safeParse(raw);
    const passage = parsed.success ? byChunk.get(parsed.data.chunkId) : undefined;
    if (
      !parsed.success ||
      !passage ||
      passage.source !== parsed.data.source ||
      passage.sourceId !== parsed.data.sourceId ||
      passage.sourceVersion !== parsed.data.sourceVersion
    ) {
      invalid += 1;
      continue;
    }
    if (!valid.includes(passage)) valid.push(passage);
  }
  return { valid, invalid };
}
