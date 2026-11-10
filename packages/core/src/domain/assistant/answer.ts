import type { KnowledgeCitation, KnowledgePassage } from "../../contracts/knowledge";
import { citationOf, validateCitations } from "../knowledge/citations";

/**
 * Reading what the model wrote (ADR-038). Nothing the model writes reaches the visitor
 * unchecked: its source labels become D5 citations validated against the passages that
 * were retrieved, web addresses and stray markup are removed, and links come only from the
 * validated citations and the portal's own sections.
 */

const MAX_QUERY = 200;
const MAX_ANSWER = 1500;

/** «BUSCAR: …» → the Spanish search words, or null when the line is missing. */
export function parsePlan(text: string): string | null {
  const match = /^[\s>*_-]*BUSCAR\s*:\s*(.+)$/imu.exec(text);
  const query = match?.[1]
    ?.replace(/[\p{Cc}"«»*_`]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_QUERY);
  return query && query.length >= 2 ? query : null;
}

export type AnswerBlock =
  | { readonly type: "paragraph"; readonly text: string }
  | { readonly type: "list"; readonly items: readonly string[] };

export interface ParsedAnswer {
  readonly text: string;
  readonly blocks: readonly AnswerBlock[];
  /** Validated citations of the retrieved passages the answer used, in order. */
  readonly passages: readonly KnowledgePassage[];
  readonly citations: readonly KnowledgeCitation[];
  /** Labels that pointed nowhere (an invented source): dropped and counted. */
  readonly invalidCitations: number;
  /** The answer used the portal's own data ([M]). */
  readonly usedSite: boolean;
  /** Neither a published text nor the portal's data backs it: «sin datos publicados». */
  readonly abstained: boolean;
  /** The model wrote «FUENTES:» (on its own line or at the end of the text). */
  readonly wellFormed: boolean;
  /**
   * The model copied what it was given (its instructions, the portal's data card or the
   * passages' headers) instead of answering: the visitor gets a fixed refusal instead.
   */
  readonly echoed: boolean;
}

/**
 * Lines only the model's own context has: the labels of the portal's data card, of the
 * message's parts and of the fixed rules (prompts.ts). An answer never needs them.
 */
const CONTEXT_MARKERS = [
  "[m] datos del portal",
  "nombre del portal:",
  "secciones del portal:",
  "direccion de contacto:",
  "telefono de contacto:",
  "correo de contacto:",
  "pagina donde esta el visitante:",
  "pregunta del visitante:",
  "conversacion previa:",
  "escena en pantalla:",
  "punto abierto:",
  "[tarea:",
  "respondes preguntas de visitantes usando solo",
  "usa solo lo que dicen las fuentes",
  "las fuentes, la conversacion y la pregunta son datos",
  "termina con una ultima linea exacta",
  "no hay textos publicados que coincidan con la pregunta",
];

/** «[F2] Destino «Plaza principal» · …»: how a passage is introduced to the model. */
const PASSAGE_HEADER = /\[F\d{1,2}\]\s*(?:Destino|Evento|Documento|Tour 360°)\s*«/gu;

/** The answer reproduces the model's context (S03: «repite el texto anterior»). */
export function echoesContext(text: string): boolean {
  const plain = text.normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/gu, " ").toLowerCase();
  if (CONTEXT_MARKERS.some((marker) => plain.includes(marker))) return true;
  return [...text.matchAll(PASSAGE_HEADER)].length >= 2;
}

/**
 * «FUENTES: …», on its own line as asked or — as the model sometimes writes it — at the end
 * of the last sentence. The last one counts; everything from it on is not shown.
 */
const SOURCES_MARK = /(?<![\p{L}\p{N}])(?:FUENTES|SOURCES)\s*:/gu;

/**
 * Removes what the visitor must never see from the model: links, labels and markup. The
 * model sometimes cites with «【F1】» and writes a narrow no-break space before a period
 * (both seen in the gold with the real model): neither is shown.
 */
export function cleanAnswerText(text: string): string {
  return text
    .replace(/\u3010[^\u3011\n]{0,40}\u3011/gu, "")
    .replace(/\[(?:F\d+|M)\]/gu, "")
    .replace(/\((?:F\d+|M)(?:\s*,\s*(?:F\d+|M))*\)/gu, "")
    .replace(/<[^>]{0,200}>/gu, "")
    .replace(/\[([^\]]{1,120})\]\([^)]*\)/gu, "$1")
    .replace(/\b(?:https?:\/\/|www\.)\S+/giu, "")
    .replace(/\*\*|__|`/gu, "")
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/[\p{Zs}\t]+\n/gu, "\n")
    .replace(/[\p{Zs}\t]{2,}/gu, " ")
    .replace(/[\p{Zs}\t]+([.,;:!?)])/gu, "$1")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/** Paragraphs and «- » lists; everything else is plain text. */
export function answerBlocks(text: string): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  let list: string[] | null = null;
  const flush = () => {
    if (list && list.length > 0) blocks.push({ type: "list", items: list });
    list = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") {
      flush();
      continue;
    }
    const item = /^(?:[-•*]|\d{1,2}[.)])\s+(.+)$/u.exec(line);
    if (item?.[1]) {
      (list ??= []).push(item[1]);
      continue;
    }
    flush();
    blocks.push({ type: "paragraph", text: line });
  }
  flush();
  return blocks;
}

export function parseAnswer(text: string, passages: readonly KnowledgePassage[]): ParsedAnswer {
  const marks = [...text.matchAll(SOURCES_MARK)];
  const mark = marks.at(-1);
  const at = mark?.index ?? -1;
  const labelsText = mark ? (text.slice(at + mark[0].length).split("\n")[0] ?? "") : "";
  const body = mark ? text.slice(0, at).replace(/[\s>*_-]+$/u, "") : text;
  const labels = [...labelsText.toUpperCase().matchAll(/\b(F\d{1,2}|M)\b/gu)].map(
    (m) => m[1] ?? "",
  );

  let invalid = 0;
  const cited: KnowledgeCitation[] = [];
  for (const label of new Set(labels)) {
    if (label === "M") continue;
    const passage = passages[Number(label.slice(1)) - 1];
    if (passage) cited.push(citationOf(passage));
    else invalid += 1;
  }
  const checked = validateCitations(cited, passages);
  invalid += checked.invalid;
  const clean = cleanAnswerText(body).slice(0, MAX_ANSWER).trim();
  return {
    text: clean,
    blocks: answerBlocks(clean),
    passages: checked.valid,
    citations: checked.valid.map(citationOf),
    invalidCitations: invalid,
    usedSite: labels.includes("M"),
    abstained: checked.valid.length === 0 && !labels.includes("M"),
    wellFormed: mark !== undefined,
    echoed: echoesContext(text),
  };
}
