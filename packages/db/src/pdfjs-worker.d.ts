// pdf.js ships no types for its worker module; only its presence matters (pdf-text.ts).
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
