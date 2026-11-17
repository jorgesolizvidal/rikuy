import {
  HERO_IMAGE_FILES,
  heroImagesPayloadSchema,
  imageVersionPrefix,
  JOB_KINDS,
  permanentFailure,
  transientFailure,
  type HeroImageStore,
  type ImageProcessor,
  type JobProcessor,
  type MediaAdmin,
} from "@rikuy/core";

export interface HeroImagesDeps {
  readonly heroes: HeroImageStore;
  readonly heroMedia: Pick<MediaAdmin, "readOriginal" | "storeDerivatives" | "publishFiles">;
  readonly imageProcessor: Pick<ImageProcessor, "heroDerivatives">;
}

/**
 * media.hero_images (ADR-070): the lighter versions of the home cover for a photo uploaded
 * before they existed. Stored next to its derivatives; copied to the public bucket when the
 * photo is public. The order makes every case end with the files where the portal looks:
 * a publication after they are stored copies them itself (they are optional files of the
 * publication), and one before is seen when the version is read again. Idempotent.
 */
export function createHeroImagesProcessor(deps: HeroImagesDeps): JobProcessor {
  return {
    kind: JOB_KINDS.heroImages,
    schemaVersions: [1],
    async run({ job }) {
      if (!heroImagesPayloadSchema.safeParse(job.payload).success) {
        throw permanentFailure("invalid_payload", "The job payload is not valid.");
      }
      const lease = { jobId: job.jobId, fencingToken: job.fencingToken };
      const source = await deps.heroes.source(lease);
      if (source === "lease_lost") throw transientFailure("lease_lost", "The lease was lost.");
      if (source === null) return { result: { outcome: "gone" } };

      const original = await storage(() => deps.heroMedia.readOriginal(source.originalPath));
      if (original === null) return { result: { outcome: "no_original" } };
      let files;
      try {
        files = await deps.imageProcessor.heroDerivatives(original);
      } catch {
        throw permanentFailure("unreadable", "The original could not be decoded.");
      }
      const prefix = imageVersionPrefix(source.tenantId, source.assetId, source.version);
      await storage(() => deps.heroMedia.storeDerivatives(prefix, files));

      // Read again: a publication that ended meanwhile did not see these files.
      const now = await deps.heroes.source(lease);
      if (now === "lease_lost") throw transientFailure("lease_lost", "The lease was lost.");
      if (now === null) return { result: { outcome: "gone" } };
      if (now.published) {
        await storage(() =>
          deps.heroMedia.publishFiles(
            source.tenantId,
            source.assetId,
            source.version,
            HERO_IMAGE_FILES,
          ),
        );
      }

      const outcome = await deps.heroes.complete(lease);
      if (outcome === "lease_lost") throw transientFailure("lease_lost", "The lease was lost.");
      if (outcome === "missing") {
        throw transientFailure("files_missing", "The stored files are not there yet.");
      }
      return { result: { outcome, published: now.published, files: files.length } };
    },
  };
}

async function storage<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw transientFailure(
      "storage_unavailable",
      error instanceof Error ? error.message : "Storage did not answer.",
    );
  }
}
