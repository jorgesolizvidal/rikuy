import {
  httpsLinkSchema,
  type RichText,
  type RichTextBlock,
  type RichTextInline,
  type RichTextMark,
  type RichTextRun,
} from "../../contracts/rich-text";

/**
 * The editor's writing format ↔ rich text AST. A small, predictable subset of Markdown
 * that municipal staff can type without a toolbar, and that never produces HTML:
 *
 *   ## Título · ### Subtítulo          paragraphs are separated by a blank line
 *   - elemento · 1. elemento           **negrita** · *cursiva* · [texto](https://…)
 *
 * A backslash makes the next character literal: \* \[ \# …
 */

export interface MarkupProblem {
  /** 1-based line of the source. */
  readonly line: number;
  readonly code: "link_not_https";
  readonly detail: string;
}

export interface ParsedMarkup {
  readonly blocks: RichText;
  readonly problems: readonly MarkupProblem[];
}

const ESCAPABLE = new Set(["\\", "*", "[", "]", "(", ")", "#", "-", ".", "•", "_"]);
const HEADING = /^(#{1,3})\s+(.*)$/u;
const BULLET = /^[-*•]\s+(.*)$/u;
const NUMBERED = /^\d{1,3}[.)]\s+(.*)$/u;

type Segment =
  | { readonly kind: "text"; readonly raw: string }
  | { readonly kind: "link"; readonly label: string; readonly href: string };

/** Splits a line into plain text and `[label](href)` links (balanced parentheses allowed). */
function splitLinks(raw: string): Segment[] {
  const segments: Segment[] = [];
  let text = "";
  let i = 0;
  while (i < raw.length) {
    const char = raw[i] ?? "";
    if (char === "\\" && i + 1 < raw.length) {
      text += char + (raw[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (char === "[") {
      const link = readLink(raw, i);
      if (link) {
        if (text) segments.push({ kind: "text", raw: text });
        text = "";
        segments.push({ kind: "link", label: link.label, href: link.href });
        i = link.end;
        continue;
      }
    }
    text += char;
    i += 1;
  }
  if (text) segments.push({ kind: "text", raw: text });
  return segments;
}

function readLink(raw: string, start: number): { label: string; href: string; end: number } | null {
  let i = start + 1;
  let label = "";
  while (i < raw.length && raw[i] !== "]") {
    if (raw[i] === "[") return null;
    if (raw[i] === "\\" && i + 1 < raw.length) {
      label += raw.slice(i, i + 2);
      i += 2;
      continue;
    }
    label += raw[i];
    i += 1;
  }
  if (raw[i] !== "]" || raw[i + 1] !== "(" || label.trim() === "") return null;
  i += 2;
  let depth = 0;
  let href = "";
  while (i < raw.length) {
    const char = raw[i] ?? "";
    if (/\s/u.test(char)) return null;
    if (char === "(") depth += 1;
    if (char === ")") {
      if (depth === 0) break;
      depth -= 1;
    }
    href += char;
    i += 1;
  }
  if (raw[i] !== ")" || href === "") return null;
  return { label, href, end: i + 1 };
}

type Token =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "mark"; readonly value: "**" | "*" };

function tokenize(raw: string): Token[] {
  const tokens: Token[] = [];
  let text = "";
  const flush = () => {
    if (text) tokens.push({ kind: "text", value: text });
    text = "";
  };
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i] ?? "";
    const next = raw[i + 1] ?? "";
    if (char === "\\" && ESCAPABLE.has(next)) {
      text += next;
      i += 1;
    } else if (char === "*") {
      flush();
      if (next === "*") {
        tokens.push({ kind: "mark", value: "**" });
        i += 1;
      } else {
        tokens.push({ kind: "mark", value: "*" });
      }
    } else {
      text += char;
    }
  }
  flush();
  return tokens;
}

/** Text with **bold** / *italic* → runs. Unpaired markers stay as literal characters. */
function emphasis(raw: string): RichTextRun[] {
  const tokens = tokenize(raw);
  const partner = new Map<number, number>();
  const open: number[] = [];
  tokens.forEach((token, index) => {
    if (token.kind !== "mark") return;
    const match = open.findLastIndex((at) => tokens[at]?.value === token.value);
    if (match === -1) {
      open.push(index);
    } else {
      const opener = open[match] ?? -1;
      partner.set(opener, index);
      partner.set(index, opener);
      open.splice(match, 1);
    }
  });

  const runs: RichTextRun[] = [];
  let bold = false;
  let italic = false;
  tokens.forEach((token, index) => {
    if (token.kind === "mark" && partner.has(index)) {
      if (token.value === "**") bold = !bold;
      else italic = !italic;
      return;
    }
    const marks: RichTextMark[] = [
      ...(bold ? ["bold" as const] : []),
      ...(italic ? ["italic" as const] : []),
    ];
    pushRun(runs, token.value, marks);
  });
  return runs;
}

function pushRun(runs: RichTextRun[], text: string, marks: readonly RichTextMark[]): void {
  if (text === "") return;
  const last = runs.at(-1);
  if (last && sameMarks(last.marks, marks)) {
    runs[runs.length - 1] = withMarks(last.text + text, marks);
  } else {
    runs.push(withMarks(text, marks));
  }
}

function withMarks(text: string, marks: readonly RichTextMark[]): RichTextRun {
  return marks.length > 0 ? { type: "text", text, marks: [...marks] } : { type: "text", text };
}

function sameMarks(a: readonly RichTextMark[] | undefined, b: readonly RichTextMark[] | undefined) {
  return (a ?? []).join() === (b ?? []).join();
}

function inlines(raw: string, line: number, problems: MarkupProblem[]): RichTextInline[] {
  const result: RichTextInline[] = [];
  for (const segment of splitLinks(raw)) {
    if (segment.kind === "text") {
      for (const run of emphasis(segment.raw)) appendInline(result, run);
      continue;
    }
    const children = emphasis(segment.label);
    if (!httpsLinkSchema.safeParse(segment.href).success) {
      problems.push({ line, code: "link_not_https", detail: segment.href });
      for (const run of children) appendInline(result, run);
      continue;
    }
    result.push({ type: "link", href: segment.href, children });
  }
  return trimInlines(result);
}

function appendInline(result: RichTextInline[], run: RichTextRun): void {
  const last = result.at(-1);
  if (last?.type === "text" && sameMarks(last.marks, run.marks)) {
    result[result.length - 1] = withMarks(last.text + run.text, run.marks ?? []);
  } else {
    result.push(run);
  }
}

/** Removes outer spaces of the block (inner spaces are kept as typed). */
function trimInlines(items: RichTextInline[]): RichTextInline[] {
  const trimmed = [...items];
  const first = trimmed[0];
  if (first?.type === "text") trimmed[0] = withMarks(first.text.trimStart(), first.marks ?? []);
  const lastIndex = trimmed.length - 1;
  const last = trimmed[lastIndex];
  if (last?.type === "text") trimmed[lastIndex] = withMarks(last.text.trimEnd(), last.marks ?? []);
  return trimmed.filter((item) => item.type !== "text" || item.text !== "");
}

type Pending =
  | { kind: "paragraph"; lines: string[]; line: number }
  | { kind: "list"; ordered: boolean; items: { text: string; line: number }[] };

export function parseMarkup(source: string): ParsedMarkup {
  const problems: MarkupProblem[] = [];
  const blocks: RichTextBlock[] = [];
  let pending: Pending | null = null;

  const flush = () => {
    if (pending?.kind === "paragraph") {
      const children = inlines(pending.lines.join(" "), pending.line, problems);
      if (children.length > 0) blocks.push({ type: "paragraph", children });
    } else if (pending?.kind === "list") {
      const items = pending.items
        .map((item) => inlines(item.text, item.line, problems))
        .filter((item) => item.length > 0);
      if (items.length > 0) blocks.push({ type: "list", ordered: pending.ordered, items });
    }
    pending = null;
  };

  const lines = source
    .replace(/\r\n?/gu, "\n")
    .replace(/\t/gu, " ")
    .replace(/[^\P{Cc}\n]/gu, "")
    .split("\n");

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    const number = index + 1;
    if (line === "") {
      flush();
      return;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const children = inlines(heading[2] ?? "", number, problems);
      const level = (heading[1] ?? "").length === 3 ? 3 : 2;
      if (children.length > 0) blocks.push({ type: "heading", level, children });
      return;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      const ordered = numbered !== null;
      const current = pending as Pending | null;
      if (current?.kind !== "list" || current.ordered !== ordered) {
        flush();
        pending = { kind: "list", ordered, items: [] };
      }
      (pending as Extract<Pending, { kind: "list" }>).items.push({
        text: (bullet ?? numbered)?.[1] ?? "",
        line: number,
      });
      return;
    }
    const current = pending as Pending | null;
    if (current?.kind === "list") {
      // A plain line right after an item continues that item.
      const last = current.items.at(-1);
      if (last) last.text = `${last.text} ${line}`;
      return;
    }
    if (current?.kind === "paragraph") current.lines.push(line);
    else pending = { kind: "paragraph", lines: [line], line: number };
  });
  flush();
  return { blocks, problems };
}

// ── AST → writing format ─────────────────────────────────────────────────────

function escapeText(text: string): string {
  return text.replace(/[\\*[\]]/gu, (char) => `\\${char}`);
}

function runToMarkup(run: RichTextRun): string {
  const bold = run.marks?.includes("bold") ?? false;
  const italic = run.marks?.includes("italic") ?? false;
  const marker = (bold ? "**" : "") + (italic ? "*" : "");
  return `${marker}${escapeText(run.text)}${[...marker].reverse().join("")}`;
}

function inlinesToMarkup(items: readonly RichTextInline[]): string {
  return items
    .map((item) =>
      item.type === "text"
        ? runToMarkup(item)
        : `[${item.children.map(runToMarkup).join("")}](${linkTarget(item.href)})`,
    )
    .join("");
}

/** Unbalanced parentheses would end the link early: percent-encode them (same URL). */
function linkTarget(href: string): string {
  let depth = 0;
  for (const char of href) {
    if (char === "(") depth += 1;
    if (char === ")" && --depth < 0) break;
  }
  return depth === 0 ? href : href.replace(/\(/gu, "%28").replace(/\)/gu, "%29");
}

/** Escapes a paragraph that would otherwise read as a heading or a list item. */
function protectLineStart(text: string): string {
  if (/^#/u.test(text) || /^[-•]\s/u.test(text)) return `\\${text}`;
  const numbered = /^(\d{1,3})([.)])(\s)/u.exec(text);
  return numbered ? `${numbered[1]}\\${text.slice((numbered[1] ?? "").length)}` : text;
}

export function richTextToMarkup(blocks: readonly RichTextBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "heading")
        return `${"#".repeat(block.level)} ${inlinesToMarkup(block.children)}`;
      if (block.type === "paragraph") return protectLineStart(inlinesToMarkup(block.children));
      return block.items
        .map((item, index) => `${block.ordered ? `${index + 1}.` : "-"} ${inlinesToMarkup(item)}`)
        .join("\n");
    })
    .join("\n\n");
}
