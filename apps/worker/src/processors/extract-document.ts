import {
  DOCUMENT_TEXT_FILE,
  extractDocumentPayloadSchema,
  extractDocumentText,
  JOB_KINDS,
  permanentFailure,
  transientFailure,
  type DocumentStore,
  type JobProcessor,
  type MediaAdmin,
  type OriginalRemover,
  type PdfTextReader,
} from "@rikuy/core";

export interface ExtractDocumentDeps {
  readonly documents: DocumentStore;
  readonly pdf: PdfTextReader;
  readonly media: Pick<MediaAdmin, "readOriginal" | "storeDerivatives"> & OriginalRemover;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * media.extract_document (ADR-037): reads the private original's real bytes — a PDF with
 * text, or a text file — and stores its text page by page next to it
 * ({prefix}document/text.json). The original never changes and is never made public.
 *
 * - Not usable (not a PDF or text, scanned, protected, damaged, too long) → the version is
 *   rejected with the reason and its original removed; no retry.
 * - Storage hiccups → transient: the ledger retries. Extraction is deterministic, so a
 *   repeated attempt writes the same file.
 */
export function createExtractDocumentProcessor(deps: ExtractDocumentDeps): JobProcessor {
  return {
    kind: JOB_KINDS.extractDocument,
    schemaVersions: [1],
    async run({ job, signal }) {
      if (!extractDocumentPayloadSchema.safeParse(job.payload).success) {
        throw permanentFailure("invalid_payload", "The job payload is not valid.");
      }
      const lease = { jobId: job.jobId, fencingToken: job.fencingToken };
      const lost = () => transientFailure("lease_lost", "The lease was lost.");

      const source = await deps.documents.source(lease);
      if (source === "lease_lost") throw lost();
      if (source === "not_found") return { result: { outcome: "not_found" } };
      if (source.status !== "processing") return { result: { outcome: "already_settled" } };

      const original = await storage(() => deps.media.readOriginal(source.originalPath));
      const extracted = original
        ? await extractDocumentText(original, deps.pdf)
        : ({ status: "rejected", problem: "unreadable" } as const);
      if (signal.aborted) throw lost();

      if (extracted.status === "rejected") {
        await storage(() => deps.media.removeOriginal(source.originalPath));
        const rejected = await deps.documents.reject(lease, extracted.problem);
        if (rejected === "lease_lost") throw lost();
        return { result: { outcome: "rejected", problem: extracted.problem } };
      }
      if (!original) throw transientFailure("missing_original", "The original is missing.");

      await storage(() =>
        deps.media.storeDerivatives(source.prefix, [
          {
            name: DOCUMENT_TEXT_FILE,
            contentType: "application/json",
            bytes: new TextEncoder().encode(JSON.stringify(extracted.text)),
          },
        ]),
      );
      const completed = await deps.documents.complete(
        lease,
        { mime: extracted.mime, bytes: original.byteLength, sha256: await sha256Hex(original) },
        extracted.manifest,
      );
      if (completed === "lease_lost") throw lost();
      return {
        result: {
          outcome: completed,
          format: extracted.manifest.format,
          pages: extracted.manifest.pages,
          characters: extracted.manifest.characters,
        },
        bytesIn: original.byteLength,
      };
    },
  };
}

/** Storage calls fail transiently (the ledger retries); their message keeps no URLs. */
async function storage<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw transientFailure(
      "storage_unavailable",
      error instanceof Error ? error.message : "Storage did not answer.",
    );
  }
}
