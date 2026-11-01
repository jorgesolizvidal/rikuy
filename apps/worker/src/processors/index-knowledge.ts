import {
  buildIndexChunks,
  documentTextSchema,
  DOCUMENT_TEXT_FILE,
  indexKnowledgePayloadSchema,
  JOB_KINDS,
  JobFailure,
  parseIndexSource,
  permanentFailure,
  transientFailure,
  type JobProcessor,
  type KnowledgeIndexStore,
  type MediaAdmin,
} from "@rikuy/core";

export interface IndexKnowledgeDeps {
  readonly knowledge: KnowledgeIndexStore;
  readonly media: Pick<MediaAdmin, "readOriginal">;
}

/** A document's text lives next to its original: `{tenant}/{asset}/{version}/`. */
const VERSION_PREFIX = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[1-9][0-9]{0,5}\/$/u;

/**
 * knowledge.index (ADR-037): cuts a sealed revision — of a destination, an event, a
 * knowledge item (with its document) or a tour — into the assistant's fragments and stores
 * them all at once. Deterministic and idempotent: indexing the same revision again stores
 * the same fragments. Whether they are used is decided by every search (the current
 * published pointer), never here.
 */
export function createIndexKnowledgeProcessor(deps: IndexKnowledgeDeps): JobProcessor {
  return {
    kind: JOB_KINDS.indexKnowledge,
    schemaVersions: [1],
    async run({ job, signal }) {
      if (!indexKnowledgePayloadSchema.safeParse(job.payload).success) {
        throw permanentFailure("invalid_payload", "The job payload is not valid.");
      }
      const lease = { jobId: job.jobId, fencingToken: job.fencingToken };
      const lost = () => transientFailure("lease_lost", "The lease was lost.");

      const raw = await deps.knowledge.source(lease);
      if (raw === "lease_lost") throw lost();
      if (
        typeof raw === "object" &&
        raw !== null &&
        "status" in raw &&
        raw.status === "not_found"
      ) {
        return { result: { outcome: "not_found" } };
      }
      const source = parseIndexSource(raw);
      if (source === null) {
        throw permanentFailure("invalid_source", "The revision could not be read for indexing.");
      }

      const readText = async (prefix: string) => {
        if (!VERSION_PREFIX.test(prefix)) {
          throw permanentFailure("invalid_prefix", "The ledger handed an unexpected folder.");
        }
        let bytes: Uint8Array | null;
        try {
          bytes = await deps.media.readOriginal(`${prefix}${DOCUMENT_TEXT_FILE}`);
        } catch (error) {
          throw transientFailure(
            "storage_unavailable",
            error instanceof Error ? error.message : "Storage did not answer.",
          );
        }
        if (bytes === null) return null;
        const parsed = documentTextSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
        return parsed.success ? parsed.data : null;
      };

      let built;
      try {
        built = await buildIndexChunks(source, readText);
      } catch (error) {
        if (error instanceof JobFailure) throw error;
        throw transientFailure("document_text_missing", "The document's text could not be read.");
      }
      if (signal.aborted) throw lost();

      const stored = await deps.knowledge.store(
        lease,
        built.chunkerVersion,
        source.title,
        built.chunks,
      );
      if (stored === "lease_lost") throw lost();
      return {
        result: {
          outcome: stored,
          source: source.source,
          chunks: built.chunks.length,
          characters: built.chunks.reduce((total, chunk) => total + chunk.body.length, 0),
        },
      };
    },
  };
}
