import {
  expireAbandonedUploadPayloadSchema,
  JOB_KINDS,
  permanentFailure,
  transientFailure,
  type AbandonedUploadStore,
  type JobProcessor,
  type OriginalRemover,
} from "@rikuy/core";

export interface ExpireAbandonedUploadDeps {
  readonly uploads: AbandonedUploadStore;
  readonly storage: OriginalRemover;
}

/**
 * media.expire_abandoned_upload: an image version still "uploading" a day later will never
 * be confirmed (its signed URL expired long ago). Removes the original if it was ever
 * written, then marks the version rejected.
 *
 * Idempotent in any order of crashes: removing a missing object is fine, and marking twice
 * changes nothing. The storage is touched only after the ledger confirmed, under this job's
 * lease, that the version is still abandoned.
 */
export function createExpireAbandonedUploadProcessor(
  deps: ExpireAbandonedUploadDeps,
): JobProcessor {
  return {
    kind: JOB_KINDS.expireAbandonedUpload,
    schemaVersions: [1],
    async run({ job }) {
      if (!expireAbandonedUploadPayloadSchema.safeParse(job.payload).success) {
        throw permanentFailure("invalid_payload", "The job payload is not valid.");
      }
      const lease = { jobId: job.jobId, fencingToken: job.fencingToken };
      const lost = () => transientFailure("lease_lost", "The lease was lost.");

      const found = await deps.uploads.inspect(lease);
      if (found === "lease_lost") throw lost();
      if (!found.abandoned || found.originalPath === null) {
        return { result: { outcome: "nothing_to_do" } };
      }

      try {
        await deps.storage.removeOriginal(found.originalPath);
      } catch (error) {
        throw transientFailure(
          "storage_unavailable",
          error instanceof Error ? error.message : "Storage did not answer.",
        );
      }

      const marked = await deps.uploads.markAbandoned(lease);
      if (marked === "lease_lost") throw lost();
      return { result: { outcome: marked } };
    },
  };
}
