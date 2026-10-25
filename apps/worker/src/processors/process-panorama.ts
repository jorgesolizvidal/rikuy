import {
  checkUploadedImage,
  inspectImage,
  isEquirectangular,
  JOB_KINDS,
  PANORAMA_FOLDER,
  PANORAMA_MANIFEST_VERSION,
  PANORAMA_RULES,
  PANORAMA_TILE_SIZE,
  permanentFailure,
  planPanorama,
  processPanoramaPayloadSchema,
  transientFailure,
  type DerivedFile,
  type JobProcessor,
  type MediaAdmin,
  type OriginalRemover,
  type PanoramaManifest,
  type PanoramaProblem,
  type PanoramaRenderer,
  type PanoramaStore,
} from "@rikuy/core";

export interface ProcessPanoramaDeps {
  readonly panoramas: PanoramaStore;
  readonly renderer: PanoramaRenderer;
  readonly media: Pick<MediaAdmin, "readOriginal" | "storeDerivatives"> & OriginalRemover;
}

/** What earlier attempts already stored (the job's checkpoint). */
type Progress = {
  readonly preview?: { readonly width: number; readonly height: number; readonly bytes: number };
  readonly image?: { readonly width: number; readonly height: number; readonly bytes: number };
  /** How many tile levels are stored. */
  readonly levels?: number;
};

const PREVIEW_FILE = "preview.webp";
const IMAGE_FILE = "image.webp";
const levelDir = (index: number) => `tiles/${index}`;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readProgress(checkpoint: unknown): Progress {
  if (typeof checkpoint !== "object" || checkpoint === null) return {};
  return checkpoint as Progress;
}

/**
 * media.process_panorama (ADR-020): from the private original, renders a blurred preview
 * (≤ 40 KB), one WebP of at most 4096 px and, for sources wider than 4096 px, 512 px
 * equirectangular tiles in several levels. Everything stays private next to the original,
 * which is never modified.
 *
 * - Not a valid 2:1 image (or unreadable) → the version is rejected with the reason and its
 *   original removed; no retry.
 * - Storage hiccups → transient: the ledger retries, and the checkpoint (saved after the
 *   preview, the image and each tile level) lets the next attempt skip what is stored.
 * - Rendering is deterministic, so repeating a step overwrites with the same files.
 */
export function createProcessPanoramaProcessor(deps: ProcessPanoramaDeps): JobProcessor {
  return {
    kind: JOB_KINDS.processPanorama,
    schemaVersions: [1],
    async run({ job, signal, saveCheckpoint }) {
      if (!processPanoramaPayloadSchema.safeParse(job.payload).success) {
        throw permanentFailure("invalid_payload", "The job payload is not valid.");
      }
      const lease = { jobId: job.jobId, fencingToken: job.fencingToken };
      const lost = () => transientFailure("lease_lost", "The lease was lost.");
      const stopIfHalted = () => {
        if (signal.aborted) throw lost();
      };

      const source = await deps.panoramas.source(lease);
      if (source === "lease_lost") throw lost();
      if (source === "not_found") return { result: { outcome: "not_found" } };
      if (source.status !== "processing") return { result: { outcome: "already_settled" } };

      const reject = async (problem: PanoramaProblem) => {
        await storage(() => deps.media.removeOriginal(source.originalPath));
        const rejected = await deps.panoramas.reject(lease, problem);
        if (rejected === "lease_lost") throw lost();
        return { result: { outcome: "rejected", problem } };
      };

      const original = await storage(() => deps.media.readOriginal(source.originalPath));
      if (original === null) return reject("unreadable");
      const info = inspectImage(original);
      const problem =
        checkUploadedImage(PANORAMA_RULES, info, original.byteLength, source.declaredMime) ??
        (info && !isEquirectangular(info.width, info.height) ? "not_equirectangular" : null);
      if (problem !== null || info === null) return reject(problem ?? "unreadable");

      const plan = planPanorama(info.width);
      const folder = `${source.prefix}${PANORAMA_FOLDER}`;
      let progress = readProgress(job.checkpoint);
      const store = (files: readonly DerivedFile[]) =>
        storage(() => deps.media.storeDerivatives(folder, files));
      // Decoding failures surface while rendering: the file is not a usable image.
      const render = async <T>(step: () => Promise<T>): Promise<T | null> => {
        try {
          return await step();
        } catch {
          return null;
        }
      };

      if (!progress.preview) {
        const preview = await render(() => deps.renderer.preview(original, plan));
        if (preview === null) return reject("unreadable");
        await store([{ ...preview.file, name: PREVIEW_FILE }]);
        progress = {
          ...progress,
          preview: {
            width: preview.width,
            height: preview.height,
            bytes: preview.file.bytes.byteLength,
          },
        };
        await saveCheckpoint(progress);
      }
      stopIfHalted();

      if (!progress.image) {
        const image = await render(() => deps.renderer.image(original, plan));
        if (image === null) return reject("unreadable");
        await store([{ ...image.file, name: IMAGE_FILE }]);
        progress = {
          ...progress,
          image: { width: image.width, height: image.height, bytes: image.file.bytes.byteLength },
        };
        await saveCheckpoint(progress);
      }

      const levels = plan.levels ?? [];
      for (let index = progress.levels ?? 0; index < levels.length; index += 1) {
        stopIfHalted();
        const level = levels[index];
        if (!level) break;
        const tiles = await render(() => deps.renderer.tiles(original, level));
        if (tiles === null) return reject("unreadable");
        await store(tiles.map((tile) => ({ ...tile, name: `${levelDir(index)}/${tile.name}` })));
        progress = { ...progress, levels: index + 1 };
        await saveCheckpoint(progress);
      }
      stopIfHalted();

      const { preview, image } = progress;
      if (!preview || !image) throw transientFailure("missing_progress", "Renditions are missing.");
      const sha256 = await sha256Hex(original);
      const manifest: PanoramaManifest = {
        version: PANORAMA_MANIFEST_VERSION,
        projection: "equirectangular",
        source: {
          width: info.width,
          height: info.height,
          bytes: original.byteLength,
          mime: info.mime,
          sha256,
        },
        preview: { file: PREVIEW_FILE, ...preview },
        image: { file: IMAGE_FILE, ...image },
        tiles:
          levels.length === 0
            ? null
            : {
                tileSize: PANORAMA_TILE_SIZE,
                format: "webp",
                levels: levels.map((level, index) => ({ ...level, dir: levelDir(index) })),
              },
      };
      const completed = await deps.panoramas.complete(
        lease,
        {
          mime: info.mime,
          bytes: original.byteLength,
          width: info.width,
          height: info.height,
          sha256,
        },
        manifest,
      );
      if (completed === "lease_lost") throw lost();
      return {
        result: { outcome: completed, tiles: levels.length > 0, width: info.width },
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
