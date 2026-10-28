import {
  JOB_KINDS,
  permanentFailure,
  removeUnusedMediaPayloadSchema,
  transientFailure,
  type JobProcessor,
  type MediaFolderRemover,
  type UnusedMediaStore,
} from "@rikuy/core";

export interface RemoveUnusedMediaDeps {
  readonly unusedMedia: UnusedMediaStore;
  readonly folders: MediaFolderRemover;
}

/** The folder of one version, exactly: `{tenant}/{asset}/{version}/`, nothing broader. */
const VERSION_FOLDER = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[1-9][0-9]{0,5}\/$/u;

/**
 * media.remove_unused (ADR-035): a photo or a logo nothing has used for 7 days. The ledger
 * rejects the version first (so nothing can start using it) and hands back its folder; the
 * files are removed after. Idempotent: a retry gets the same folder and removing missing
 * files is fine; a version used again gets nothing.
 */
export function createRemoveUnusedMediaProcessor(deps: RemoveUnusedMediaDeps): JobProcessor {
  return {
    kind: JOB_KINDS.removeUnusedMedia,
    schemaVersions: [1],
    async run({ job }) {
      if (!removeUnusedMediaPayloadSchema.safeParse(job.payload).success) {
        throw permanentFailure("invalid_payload", "The job payload is not valid.");
      }
      const lease = { jobId: job.jobId, fencingToken: job.fencingToken };
      const folder = await deps.unusedMedia.claim(lease);
      if (folder === "lease_lost") throw transientFailure("lease_lost", "The lease was lost.");
      if (folder === null) return { result: { outcome: "in_use" } };
      if (!VERSION_FOLDER.test(folder)) {
        throw permanentFailure("invalid_folder", "The ledger handed an unexpected folder.");
      }
      try {
        const removed = await deps.folders.removeVersionFolder(folder);
        return { result: { outcome: "removed", files: removed } };
      } catch (error) {
        throw transientFailure(
          "storage_unavailable",
          error instanceof Error ? error.message : "Storage did not answer.",
        );
      }
    },
  };
}
