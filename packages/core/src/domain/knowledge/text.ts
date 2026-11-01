import type { DocumentPage } from "../../contracts/knowledge";

/**
 * Turning extracted text (a TXT file, or a PDF page by page) into clean blocks: headings and
 * paragraphs with the page they come from. Printed books lose their layout when converted
 * to text: lines are hard-wrapped, words are hyphenated at the end of a line, and running
 * headers and page numbers repeat on every page. All of that is undone here.
 */

export interface TextBlock {
  readonly type: "heading" | "paragraph";
  readonly text: string;
  readonly pageFrom: number | null;
  readonly pageTo: number | null;
}

/** Decodes a text file: UTF-8 (with or without BOM), else Windows-1252. Null: not text. */
export function decodeTextFile(
  bytes: Uint8Array,
): { readonly text: string; readonly encoding: "utf-8" | "windows-1252" } | null {
  if (bytes.byteLength === 0) return null;
  // Binary formats that are not plain text (PDF, ZIP/DOCX, PNG, JPEG, GIF, GLB).
  const head = String.fromCharCode(...bytes.subarray(0, 4));
  if (["%PDF", "PK\u0003\u0004", "\u0089PNG", "GIF8", "glTF"].includes(head)) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return null;
  if (bytes.includes(0)) return null;

  let text: string;
  let encoding: "utf-8" | "windows-1252" = "utf-8";
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes);
    encoding = "windows-1252";
  }
  // Text has very few control characters besides line breaks, tabs and page feeds.
  let controls = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if ((code < 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13) || code === 127) {
      controls += 1;
    }
  }
  if (controls > Math.max(2, text.length * 0.001)) return null;
  return { text, encoding };
}

const MARK_END = /^\s*(\d{1,4})\s*\|\s*$/u;
const MARK_START = /^\s*\|\s*(\d{1,4})\s*$/u;

/**
 * Splits a text file into pages: by page feeds, or by the printed page numbers a book keeps
 * after conversion ("14 |", "| 15", alone on their line, at the bottom of each page). Three
 * marks at least, else the file has no pages. Garbled numbers are corrected from the
 * sequence (a scanned "21" between 26 and 28 is page 27).
 */
export function splitTextPages(text: string): DocumentPage[] {
  const normalized = text.replace(/\r\n?/gu, "\n");
  if (normalized.includes("\f")) {
    const parts = normalized.split("\f");
    if (parts.filter((part) => part.trim() !== "").length >= 2) {
      return parts
        .map((part, index) => ({ page: index + 1, text: part }))
        .filter((page) => page.text.trim() !== "");
    }
  }

  const lines = normalized.split("\n");
  const marks: { line: number; printed: number }[] = [];
  lines.forEach((line, index) => {
    const match = MARK_END.exec(line) ?? MARK_START.exec(line);
    if (match?.[1]) marks.push({ line: index, printed: Number(match[1]) });
  });
  if (marks.length < 3) return [{ page: null, text: normalized }];

  const pages: DocumentPage[] = [];
  let previous: number | null = null;
  let start = 0;
  for (const mark of marks) {
    const page: number =
      previous === null
        ? Math.min(Math.max(mark.printed, 1), 9999)
        : mark.printed === previous + 1 || mark.printed === previous + 2
          ? mark.printed
          : previous + 1;
    pages.push({ page, text: lines.slice(start, mark.line).join("\n") });
    previous = page;
    start = mark.line + 1;
  }
  const rest = lines.slice(start).join("\n");
  if (rest.trim() !== "") pages.push({ page: Math.min((previous ?? 0) + 1, 9999), text: rest });
  return pages.filter((page) => page.text.trim() !== "");
}

/** Visible characters (no surrounding blanks) of the extracted pages. */
export function textCharacters(pages: readonly DocumentPage[]): number {
  return pages.reduce((total, page) => total + page.text.replace(/\s+/gu, " ").trim().length, 0);
}

function cleanLine(line: string): string {
  return line
    .normalize("NFC")
    .replace(/\u00ad/gu, "")
    .replace(/[\t\u00a0\u2000-\u200b\u202f\u205f\u3000]/gu, " ")
    .replace(/\p{Cc}/gu, "")
    .replace(/ {2,}/gu, " ")
    .trim();
}

const PAGE_NUMBER = /^(?:-\s*)?(?:p[áa]g(?:ina)?\.?\s*)?\d{1,4}(?:\s*-)?$|^\|?\s*\d{1,4}\s*\|?$/iu;

function letters(text: string): { all: number; upper: number } {
  let all = 0;
  let upper = 0;
  for (const char of text) {
    if (/\p{L}/u.test(char)) {
      all += 1;
      if (char !== char.toLowerCase() && char === char.toUpperCase()) upper += 1;
    }
  }
  return { all, upper };
}

const NUMBERED = /^(?:\d{1,2}(?:\.\d{1,2}){0,3}\.?|[IVXLC]{1,6}\.)\s+(\S.*)$/u;

function isUppercaseLine(line: string, minLetters: number): boolean {
  const { all, upper } = letters(line);
  return all >= minLetters && upper / all >= 0.85 && line.length <= 90 && !/[,;]$/u.test(line);
}

function isHeading(line: string): boolean {
  const numbered = NUMBERED.exec(line);
  if (numbered?.[1]) {
    const { all, upper } = letters(numbered[1]);
    return all >= 3 && upper / all >= 0.6 && line.length <= 160;
  }
  return isUppercaseLine(line, 4);
}

/** A line repeated near the top or bottom of most pages (title of the book, chapter…). */
function runningLines(pages: readonly (readonly string[])[]): Set<string> {
  const repeated = new Set<string>();
  if (pages.length < 4) return repeated;
  const key = (line: string) => line.replace(/\d+/gu, "#").toLowerCase();
  const counts = new Map<string, number>();
  for (const lines of pages) {
    const edges = new Set([...lines.slice(0, 2), ...lines.slice(-2)].map(key));
    for (const edge of edges) counts.set(edge, (counts.get(edge) ?? 0) + 1);
  }
  for (const [line, count] of counts) {
    if (line.length >= 3 && count >= Math.max(3, pages.length * 0.5)) repeated.add(line);
  }
  return repeated;
}

const SENTENCE_END = /[.!?:»"”)\]]$/u;

/**
 * Headings and paragraphs, in order, from extracted pages. Paragraph breaks: blank lines,
 * headings, and a line that ends a sentence clearly before the usual line width.
 */
export function textBlocks(pages: readonly DocumentPage[]): TextBlock[] {
  const cleaned = pages.map((page) =>
    page.text.replace(/\r\n?/gu, "\n").split("\n").map(cleanLine),
  );
  const repeated = runningLines(cleaned.map((lines) => lines.filter((line) => line !== "")));
  const lengths = cleaned
    .flat()
    .map((line) => line.length)
    .filter((length) => length >= 20)
    .sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)] ?? 80;

  const blocks: TextBlock[] = [];
  let paragraph: { text: string; from: number | null; to: number | null } | null = null;
  let heading: { text: string; page: number | null; lines: number } | null = null;

  const flushParagraph = () => {
    if (paragraph && paragraph.text.trim() !== "") {
      blocks.push({
        type: "paragraph",
        text: paragraph.text.trim(),
        pageFrom: paragraph.from,
        pageTo: paragraph.to,
      });
    }
    paragraph = null;
  };
  const flushHeading = () => {
    if (heading) {
      blocks.push({
        type: "heading",
        text: heading.text.replace(/[\s.:-]+$/u, "").trim(),
        pageFrom: heading.page,
        pageTo: heading.page,
      });
    }
    heading = null;
  };

  cleaned.forEach((lines, pageIndex) => {
    const page = pages[pageIndex]?.page ?? null;
    for (const line of lines) {
      if (line === "") {
        flushHeading();
        flushParagraph();
        continue;
      }
      if (PAGE_NUMBER.test(line) || repeated.has(line.replace(/\d+/gu, "#").toLowerCase())) {
        continue;
      }
      // A heading may continue on the next uppercase lines.
      if (heading && heading.lines < 3 && isUppercaseLine(line, 2) && heading.text.length < 200) {
        heading = { ...heading, text: `${heading.text} ${line}`, lines: heading.lines + 1 };
        continue;
      }
      if (isHeading(line)) {
        flushHeading();
        flushParagraph();
        heading = { text: line, page, lines: 1 };
        continue;
      }
      flushHeading();
      const current: { text: string; from: number | null; to: number | null } | null = paragraph;
      if (current === null) {
        paragraph = { text: line, from: page, to: page };
      } else if (/\p{Ll}-$/u.test(current.text) && /^\p{Ll}/u.test(line)) {
        // "organi-" + "zación": a word cut at the end of the line.
        paragraph = { text: current.text.slice(0, -1) + line, from: current.from, to: page };
      } else {
        paragraph = { text: `${current.text} ${line}`, from: current.from, to: page };
      }
      if (SENTENCE_END.test(line) && line.length < median * 0.7) flushParagraph();
    }
  });
  flushHeading();
  flushParagraph();
  return blocks;
}
