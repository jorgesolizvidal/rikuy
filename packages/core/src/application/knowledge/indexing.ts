import type { DocumentText } from "../../contracts/knowledge";
import { CHUNKER_VERSION, chunkUnits, type Chunk } from "../../domain/knowledge/chunker";
import {
  contentUnits,
  indexSourceSchema,
  tourUnits,
  type IndexSource,
} from "../../domain/knowledge/sources";
import type { StoredChunk } from "./ports";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Reads what the database described; null when it is not a revision the indexer knows. */
export function parseIndexSource(raw: unknown): IndexSource | null {
  const parsed = indexSourceSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * The fragments of a sealed revision (ADR-037), with their hashes. `readText` gives the
 * extracted text of the revision's document, when it has one.
 */
export async function buildIndexChunks(
  source: IndexSource,
  readText: (prefix: string) => Promise<DocumentText | null>,
): Promise<{ readonly chunkerVersion: number; readonly chunks: readonly StoredChunk[] }> {
  let chunks: Chunk[];
  if (source.source === "tour") {
    chunks = chunkUnits(tourUnits(source));
  } else {
    const text = source.document ? await readText(source.document.prefix) : null;
    if (source.document && text === null) {
      throw new Error("The document's text is missing");
    }
    chunks = chunkUnits(contentUnits(source, text));
  }
  return {
    chunkerVersion: CHUNKER_VERSION,
    chunks: await Promise.all(
      chunks.map(async (chunk) => ({ ...chunk, sha256: await sha256Hex(chunk.body) })),
    ),
  };
}
