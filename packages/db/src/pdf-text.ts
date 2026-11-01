// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- see model-optimizer.ts
/// <reference path="./pdfjs-worker.d.ts" />
import type { DocumentPage, PdfTextReader } from "@rikuy/core";

/**
 * Text of a PDF, page by page, with pdf.js (pure JavaScript; no fonts, no rendering, no
 * scripts). Lines are rebuilt from the text items: a new line where pdf.js marks one or
 * where the baseline moves. A password-protected file is reported, never opened.
 * Only for job runtimes (@rikuy/db/worker).
 */
export function createPdfTextReader(): PdfTextReader {
  return {
    async read(bytes, limits) {
      const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
      // pdf.js runs its "worker" in this same thread in Node: handing it the module here
      // (instead of letting it import a file by path) keeps the bundler tracing it.
      const scope = globalThis as { pdfjsWorker?: unknown };
      scope.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
      const task = getDocument({
        // pdf.js may transfer the buffer: it gets a copy.
        data: bytes.slice(),
        useSystemFonts: false,
        disableFontFace: true,
        stopAtErrors: false,
        verbosity: 0,
      });
      try {
        const pdf = await task.promise;
        if (pdf.numPages > limits.maxPages) return { status: "too_many_pages" };
        const pages: DocumentPage[] = [];
        for (let number = 1; number <= pdf.numPages; number += 1) {
          const page = await pdf.getPage(number);
          const content = await page.getTextContent();
          let text = "";
          let lastY: number | null = null;
          let lastEnd: number | null = null;
          for (const item of content.items) {
            if (!("str" in item)) continue;
            const x = item.transform[4] ?? 0;
            const y = item.transform[5] ?? 0;
            const height = Math.abs(item.height || item.transform[3] || 10);
            if (lastY !== null && Math.abs(y - lastY) > height / 2) {
              if (!text.endsWith("\n")) text += "\n";
            } else if (
              lastEnd !== null &&
              x - lastEnd > height * 0.15 &&
              !/\s$/u.test(text) &&
              !/^\s/u.test(item.str)
            ) {
              // Same line, with a visible gap: a space between words.
              text += " ";
            }
            text += item.str;
            if (item.hasEOL) text += "\n";
            lastY = y;
            lastEnd = x + (item.width || 0);
          }
          pages.push({ page: number, text: text.replace(/[ \t]+\n/gu, "\n") });
          page.cleanup();
        }
        return { status: "ok", pages };
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        if (name === "PasswordException") return { status: "encrypted" };
        return { status: "unreadable" };
      } finally {
        await task.destroy();
      }
    },
  };
}
