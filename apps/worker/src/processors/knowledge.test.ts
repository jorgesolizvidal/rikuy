import {
  drainJobs,
  type DocumentManifest,
  type DocumentProblem,
  type StoredChunk,
} from "@rikuy/core";
import { createMemoryJobLedger } from "@rikuy/core/testing";
import { describe, expect, it } from "vitest";

import { createExtractDocumentProcessor } from "./extract-document";
import { createIndexKnowledgeProcessor } from "./index-knowledge";

const VERSION = "5eed3000-0000-4000-8000-000000000009";
const PREFIX = "5eed1000-0000-4000-8000-000000000001/5eed2000-0000-4000-8000-000000000001/1/";
const REVISION = "5eed4000-0000-4000-8000-000000000001";

function storageWith(files: Map<string, Uint8Array>, failures = { reads: 0 }) {
  return {
    async readOriginal(path: string) {
      if (failures.reads > 0) {
        failures.reads -= 1;
        throw new Error("storage answered 503");
      }
      return files.get(path) ?? null;
    },
    async storeDerivatives(prefix: string, stored: readonly { name: string; bytes: Uint8Array }[]) {
      for (const file of stored) files.set(`${prefix}${file.name}`, file.bytes);
    },
    async removeOriginal(path: string) {
      files.delete(path);
    },
  };
}

async function extract(original: Uint8Array | null, status = "processing") {
  const files = new Map<string, Uint8Array>();
  if (original) files.set(`${PREFIX}original`, original);
  const completed: { manifest: DocumentManifest; mime: string }[] = [];
  const rejected: DocumentProblem[] = [];
  const ledger = createMemoryJobLedger();
  ledger.add({ jobId: "j", kind: "media.extract_document", payload: { versionId: VERSION } });
  await drainJobs({
    ledger,
    processors: [
      createExtractDocumentProcessor({
        documents: {
          source: async () => ({
            status: status as "processing",
            originalPath: `${PREFIX}original`,
            declaredMime: "text/plain",
            prefix: PREFIX,
          }),
          complete: async (_lease, metadata, manifest) => {
            completed.push({ manifest, mime: metadata.mime });
            return "ready";
          },
          reject: async (_lease, problem) => {
            rejected.push(problem);
            return "rejected";
          },
        },
        pdf: { read: async () => ({ status: "unreadable" }) },
        media: storageWith(files),
      }),
    ],
    runnerId: "test",
    budgetMs: 2_000,
  });
  return { job: ledger.jobs.get("j"), files, completed, rejected };
}

describe("media.extract_document", () => {
  it("stores the text next to the original and completes with its manifest", async () => {
    const book = new TextEncoder().encode("Uno.\n14 |\nDos.\n| 15\nTres.\n16 |\nCuatro.");
    const { job, files, completed } = await extract(book);
    expect(job?.status).toBe("succeeded");
    expect(completed[0]).toMatchObject({
      mime: "text/plain",
      manifest: { format: "txt", pages: 4, encoding: "utf-8" },
    });
    const text = JSON.parse(new TextDecoder().decode(files.get(`${PREFIX}document/text.json`)));
    expect(text.pages.map((page: { page: number }) => page.page)).toEqual([14, 15, 16, 17]);
    expect(files.has(`${PREFIX}original`)).toBe(true);
  });

  it("rejects what is not a document and removes its original", async () => {
    const { job, files, rejected } = await extract(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]));
    expect(job?.result).toEqual({ outcome: "rejected", problem: "not_a_document" });
    expect(rejected).toEqual(["not_a_document"]);
    expect(files.size).toBe(0);
  });

  it("rejects a missing original and leaves a settled version alone", async () => {
    expect((await extract(null)).rejected).toEqual(["unreadable"]);
    const settled = await extract(new TextEncoder().encode("Hola."), "ready");
    expect(settled.job?.result).toEqual({ outcome: "already_settled" });
    expect(settled.completed).toEqual([]);
  });
});

describe("knowledge.index", () => {
  const source = (document: unknown = null) => ({
    status: "ok",
    source: "content",
    kind: "knowledge",
    slug: "libro",
    revisionNo: 2,
    title: "Libro histórico",
    summary: "Historia del pueblo.",
    body: [],
    timezone: "America/La_Paz",
    schedule: null,
    venueTitle: null,
    document,
  });
  const manifest: DocumentManifest = {
    version: 1,
    format: "txt",
    pages: null,
    characters: 20,
    textFile: "document/text.json",
    encoding: "utf-8",
  };

  async function index(
    raw: unknown,
    files = new Map<string, Uint8Array>(),
    failures = { reads: 0 },
  ) {
    const stored: { title: string; chunks: readonly StoredChunk[] }[] = [];
    const ledger = createMemoryJobLedger();
    ledger.add({
      jobId: "j",
      kind: "knowledge.index",
      payload: { source: "content", revisionId: REVISION },
      maxAttempts: 3,
    });
    await drainJobs({
      ledger,
      processors: [
        createIndexKnowledgeProcessor({
          knowledge: {
            source: async () => raw,
            store: async (_lease, _version, title, chunks) => {
              stored.push({ title, chunks });
              return "stored";
            },
          },
          media: storageWith(files, failures),
        }),
      ],
      runnerId: "test",
      budgetMs: 2_000,
    });
    return { job: ledger.jobs.get("j"), stored };
  }

  it("stores the revision's fragments, its document included", async () => {
    const files = new Map([
      [
        `${PREFIX}document/text.json`,
        new TextEncoder().encode(
          JSON.stringify({ version: 1, pages: [{ page: null, text: "El texto del libro." }] }),
        ),
      ],
    ]);
    const { job, stored } = await index(source({ prefix: PREFIX, manifest }), files);
    expect(job?.status).toBe("succeeded");
    expect(stored[0]?.title).toBe("Libro histórico");
    expect(stored[0]?.chunks.map((chunk) => chunk.body)).toEqual([
      "Historia del pueblo.\n\nEl texto del libro.",
    ]);
  });

  it("retries while the document's text cannot be read, and ends a revision that is gone", async () => {
    const { job } = await index(source({ prefix: PREFIX, manifest }), new Map(), { reads: 5 });
    expect(job?.status).toBe("dead_letter");
    expect(job?.attempts).toBe(3);
    const gone = await index({ status: "not_found" });
    expect(gone.job?.result).toEqual({ outcome: "not_found" });
    expect(gone.stored).toEqual([]);
  });

  it("never follows a folder outside a media version", async () => {
    const { job, stored } = await index(source({ prefix: "../otro/", manifest }));
    expect(job?.status).toBe("dead_letter");
    expect(stored).toEqual([]);
  });
});
