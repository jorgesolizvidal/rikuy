import type { RichText } from "../../contracts/rich-text";
import type { TextBlock } from "./text";

/**
 * Fragments for the assistant's search (ADR-037). Deterministic: the same revision always
 * gives the same fragments, so indexing it again changes nothing. Changing any rule here
 * means a new CHUNKER_VERSION (and a migration that indexes again).
 */
export const CHUNKER_VERSION = 1;

export const CHUNK_SIZE = {
  /** Aim (characters, ≈ 375 tokens in Spanish). */
  target: 1500,
  /** Never more (the database accepts up to 4000). */
  max: 2200,
  /** A shorter tail joins the previous fragment of the same section. */
  min: 250,
  /** The last sentence repeated at the start of the next fragment, when this short. */
  overlap: 300,
} as const;

/** A part of a source that is cited on its own: the whole item, a tour scene or a tour point. */
export interface ChunkUnit {
  /** Shown before the section ("Sala principal", "Sala principal · El horno"). */
  readonly heading: string | null;
  readonly sceneId: string | null;
  readonly hotspotId: string | null;
  readonly blocks: readonly TextBlock[];
}

export interface Chunk {
  readonly chunkNo: number;
  readonly heading: string | null;
  readonly body: string;
  readonly pageFrom: number | null;
  readonly pageTo: number | null;
  readonly sceneId: string | null;
  readonly hotspotId: string | null;
}

// Abbreviations that end with a period without ending the sentence.
const ABBREVIATIONS = new Set([
  "sr",
  "sra",
  "srta",
  "dr",
  "dra",
  "lic",
  "ing",
  "prof",
  "arq",
  "gral",
  "cnel",
  "tte",
  "cap",
  "sto",
  "sta",
  "pág",
  "pag",
  "págs",
  "núm",
  "nro",
  "no",
  "art",
  "etc",
  "vol",
  "cap",
  "av",
  "ej",
  "aprox",
  "ca",
  "s",
  "p",
  "pp",
  "ed",
  "eds",
  "km",
  "mt",
  "hs",
  "hrs",
]);

/** Sentences of a paragraph (keeps "Dr. Pérez" and "pág. 14" together). */
export function sentences(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  const pattern = /[.!?…]+["»”)]?\s+(?=[«"“¿¡(]?[\p{Lu}\d])/gu;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const before = text.slice(start, match.index);
    const lastWord = /(\p{L}+)$/u.exec(before)?.[1]?.toLowerCase() ?? "";
    if (match[0].startsWith(".") && match[0].trim() === "." && ABBREVIATIONS.has(lastWord))
      continue;
    const end = match.index + match[0].trimEnd().length;
    parts.push(text.slice(start, end).trim());
    start = match.index + match[0].length;
  }
  const rest = text.slice(start).trim();
  if (rest !== "") parts.push(rest);
  return parts.filter((part) => part !== "");
}

/** A sentence longer than the maximum, cut between words. */
function cutLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const pieces: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/u)) {
    if (current !== "" && current.length + 1 + word.length > max) {
      pieces.push(current);
      current = "";
    }
    current = current === "" ? word.slice(0, max) : `${current} ${word}`;
  }
  if (current !== "") pieces.push(current);
  return pieces;
}

function joinHeading(unit: string | null, section: string | null): string | null {
  const parts = [unit, section].filter((part): part is string => !!part && part.trim() !== "");
  if (parts.length === 0) return null;
  return parts.join(" · ").slice(0, 300);
}

/**
 * Fragments of some units, in order. A fragment never mixes two units or two sections;
 * within a section, paragraphs are packed up to the target size and long paragraphs are
 * split by sentences, the last one repeated at the start of the next fragment.
 */
export function chunkUnits(units: readonly ChunkUnit[], size = CHUNK_SIZE): Chunk[] {
  const chunks: Chunk[] = [];

  for (const unit of units) {
    let section: string | null = null;
    let parts: string[] = [];
    let length = 0;
    let pageFrom: number | null = null;
    let pageTo: number | null = null;
    let carried: string | null = null;

    const emit = (keepTail: boolean) => {
      const body = parts.join("\n\n").trim();
      if (body === "" || body === carried) {
        parts = [];
        length = 0;
        return;
      }
      const previous = chunks.at(-1);
      const heading = joinHeading(unit.heading, section);
      if (
        body.length < size.min &&
        previous &&
        previous.heading === heading &&
        previous.sceneId === unit.sceneId &&
        previous.hotspotId === unit.hotspotId &&
        previous.body.length + body.length + 2 <= size.max
      ) {
        chunks[chunks.length - 1] = {
          ...previous,
          body: `${previous.body}\n\n${body}`,
          pageFrom: previous.pageFrom ?? pageFrom,
          pageTo: pageTo ?? previous.pageTo,
        };
      } else {
        chunks.push({
          chunkNo: chunks.length,
          heading,
          body,
          pageFrom: pageFrom ?? pageTo,
          pageTo: pageTo ?? pageFrom,
          sceneId: unit.sceneId,
          hotspotId: unit.hotspotId,
        });
      }
      const last = keepTail ? sentences(parts.at(-1) ?? "").at(-1) : undefined;
      carried = last && last.length <= size.overlap && last !== body ? last : null;
      parts = carried ? [carried] : [];
      length = carried?.length ?? 0;
      pageFrom = keepTail ? pageTo : null;
      pageTo = keepTail ? pageTo : null;
    };

    const add = (text: string, from: number | null, to: number | null) => {
      if (length > 0 && length + 2 + text.length > size.target) emit(true);
      parts.push(text);
      length += text.length + (parts.length > 1 ? 2 : 0);
      pageFrom = pageFrom ?? from;
      pageTo = to ?? pageTo;
    };

    for (const block of unit.blocks) {
      if (block.type === "heading") {
        emit(false);
        carried = null;
        parts = [];
        length = 0;
        pageFrom = null;
        pageTo = null;
        section = block.text;
        continue;
      }
      if (block.text.length <= size.target) {
        add(block.text, block.pageFrom, block.pageTo);
        continue;
      }
      // A long paragraph: sentence by sentence. After a cut, the next fragment starts with
      // the repeated sentence, which belongs to this same paragraph.
      let first = true;
      for (const sentence of sentences(block.text)) {
        for (const piece of cutLong(sentence, size.max)) {
          if (length > 0 && length + 1 + piece.length > size.target) emit(true);
          if (first || parts.length === 0) {
            parts.push(piece);
            length += piece.length + (parts.length > 1 ? 2 : 0);
            first = false;
          } else {
            parts[parts.length - 1] = `${parts[parts.length - 1]} ${piece}`;
            length += piece.length + 1;
          }
          pageFrom = pageFrom ?? block.pageFrom;
          pageTo = block.pageTo ?? pageTo;
        }
      }
    }
    emit(false);
  }

  return chunks.map((chunk, index) => ({ ...chunk, chunkNo: index }));
}

/** Rich text as blocks: headings stay headings, a list is one paragraph of bullet lines. */
export function richTextBlocks(body: RichText): TextBlock[] {
  const inline = (
    children: readonly { type: string; text?: string; children?: readonly { text: string }[] }[],
  ) =>
    children
      .map((child) =>
        child.type === "text"
          ? (child.text ?? "")
          : (child.children ?? []).map((run) => run.text).join(""),
      )
      .join("")
      .trim();
  return body
    .map((block): TextBlock => {
      if (block.type === "list") {
        return {
          type: "paragraph",
          text: block.items.map((item) => `• ${inline(item)}`).join("\n"),
          pageFrom: null,
          pageTo: null,
        };
      }
      return {
        type: block.type === "heading" ? "heading" : "paragraph",
        text: inline(block.children),
        pageFrom: null,
        pageTo: null,
      };
    })
    .filter((block) => block.text !== "");
}

/** Plain paragraph block (no page). */
export function paragraph(text: string): TextBlock {
  return { type: "paragraph", text: text.trim(), pageFrom: null, pageTo: null };
}
