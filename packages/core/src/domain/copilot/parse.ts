import type { CopilotAnswerBlock, ProposalField } from "../../contracts/copilot";
import { richTextSchema, type RichText, type RichTextInline } from "../../contracts/rich-text";
import { answerBlocks, cleanAnswerText } from "../assistant/answer";
import { parseMarkup } from "../content/markup";
import { PROPOSAL_LABELS } from "./prompts";

/**
 * Reading what the Copilot's model wrote (ADR-042). Nothing reaches the staff unchecked:
 * an answer keeps only text and the labels it used (mapped to links by the caller); a
 * proposal keeps only the fields that were asked, each validated as the database would
 * (and links the base did not already have become plain text).
 */

/** «FUENTES: …» on its own line or at the end of the text; the last one counts. */
const SOURCES_MARK = /(?<![\p{L}\p{N}])(?:FUENTES|SOURCES)\s*:/gu;

function splitSources(text: string): { readonly body: string; readonly labels: string[] } {
  const marks = [...text.matchAll(SOURCES_MARK)];
  const mark = marks.at(-1);
  if (!mark || mark.index === undefined) return { body: text, labels: [] };
  const line = text.slice(mark.index + mark[0].length).split("\n")[0] ?? "";
  const labels = [...line.toUpperCase().matchAll(/\b([CF]\d{1,2}|U|A)\b/gu)].map((m) => m[1] ?? "");
  return {
    body: text.slice(0, mark.index).replace(/[\s>*_-]+$/u, ""),
    labels: [...new Set(labels)],
  };
}

export interface ParsedCopilotAnswer {
  readonly blocks: readonly CopilotAnswerBlock[];
  /** The labels the answer says it used (C1, F2, U…), not yet checked against the data. */
  readonly labels: readonly string[];
}

export function parseCopilotAnswer(text: string): ParsedCopilotAnswer {
  const { body, labels } = splitSources(text);
  const clean = cleanAnswerText(
    body
      .replace(/\[(?:[CF]\d{1,2}|U|A|R)\]/gu, "")
      .replace(/\((?:[CF]\d{1,2}|U)(?:\s*,\s*(?:[CF]\d{1,2}|U))*\)/gu, ""),
  ).slice(0, 2500);
  return { blocks: answerBlocks(clean), labels };
}

const PLACEHOLDER =
  /\[(?:completar|pendiente|insertar|agregar|dato|nombre|fecha)[^\]]*\]|<[^<>]{1,60}>/iu;

function oneLine(value: string): string {
  return value
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/^[«"“'*_\s]+|[»"”'*_\s]+$/gu, "")
    .trim();
}

/** Cut at the last sentence that fits (never mid-word), or null when nothing sensible fits. */
function fit(value: string, max: number, min: number): string | null {
  if (value.length <= max) return value.length >= min ? value : null;
  const head = value.slice(0, max);
  const end = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  return end + 1 >= Math.max(min, max / 2) ? head.slice(0, end + 1) : null;
}

/** Links of the proposal stay only if the base already had them (the model invents URLs). */
function keepKnownLinks(blocks: RichText, allowed: ReadonlySet<string>): RichText {
  const inlines = (items: readonly RichTextInline[]): RichTextInline[] =>
    items.flatMap((inline) =>
      inline.type === "link" && !allowed.has(inline.href) ? inline.children : [inline],
    );
  return blocks.map((block) =>
    block.type === "list"
      ? { ...block, items: block.items.map((item) => inlines(item)) }
      : { ...block, children: inlines(block.children) },
  ) as RichText;
}

export function linksOf(blocks: RichText): Set<string> {
  const links = new Set<string>();
  const visit = (items: readonly RichTextInline[]) => {
    for (const inline of items) if (inline.type === "link") links.add(inline.href);
  };
  for (const block of blocks) {
    if (block.type === "list") block.items.forEach(visit);
    else visit(block.children);
  }
  return links;
}

export type ProposedValues = Partial<Record<ProposalField, string | RichText>>;

export interface ParsedProposal {
  readonly values: ProposedValues;
  /** Asked, but missing or invalid in what the model wrote. */
  readonly dropped: readonly ProposalField[];
  readonly labels: readonly string[];
}

function labelLine(field: ProposalField): RegExp {
  const label = field === "description" ? "DESCRIPCI[OÓ]N" : PROPOSAL_LABELS[field];
  return new RegExp(`^[\\s>*_#-]*${label}[*_]*\\s*:[*_]*[ \\t]*(.*)$`, "mu");
}

// The labels in capitals, as the model is asked to write them: a line of the text that
// starts with «Texto…» or «Resumen:» is text, not a label.
const ANY_LABEL =
  /^[\s>*_#-]*(?:(?:NOMBRE|RESUMEN|DESCRIPCI[OÓ]N|TEXTO|FUENTES)[*_]*\s*:|FIN_TEXTO)/u;

function bodySource(text: string): string | null {
  const start = labelLine("body").exec(text);
  if (!start || start.index === undefined) return null;
  const rest = [
    start[1] ?? "",
    ...text
      .slice(start.index + start[0].length)
      .split("\n")
      .slice(1),
  ];
  const lines: string[] = [];
  for (const line of rest) {
    if (ANY_LABEL.test(line)) break;
    lines.push(line);
  }
  return lines.join("\n").trim();
}

/** The fields the model wrote, each validated for the database (ADR-042). */
export function parseProposal(
  text: string,
  fields: readonly ProposalField[],
  options: { readonly allowedLinks?: ReadonlySet<string> } = {},
): ParsedProposal {
  const { body, labels } = splitSources(text);
  const values: ProposedValues = {};
  const dropped: ProposalField[] = [];
  for (const field of fields) {
    let value: string | RichText | null = null;
    if (field === "body") {
      const source = bodySource(body);
      if (source && !PLACEHOLDER.test(source)) {
        const parsed = parseMarkup(source);
        const blocks = keepKnownLinks(parsed.blocks, options.allowedLinks ?? new Set());
        const checked = richTextSchema.safeParse(blocks);
        if (checked.success && checked.data.length > 0) value = checked.data;
      }
    } else {
      const raw = labelLine(field).exec(body)?.[1];
      const line = raw === undefined ? "" : oneLine(raw);
      if (line && !PLACEHOLDER.test(line)) {
        value =
          field === "title"
            ? fit(line, 120, 1)
            : field === "summary"
              ? fit(line, 300, 20)
              : fit(line, 1000, 20);
      }
    }
    if (value === null) dropped.push(field);
    else values[field] = value;
  }
  return { values, dropped, labels };
}
