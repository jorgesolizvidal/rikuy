import {
  isGlb,
  JOB_KINDS,
  MODEL_FILE,
  MODEL_FOLDER,
  MODEL_LIMITS,
  MODEL_MANIFEST_VERSION,
  modelWeight,
  permanentFailure,
  processModelPayloadSchema,
  TEXTURE_TOLERANCE,
  transientFailure,
  VERTEX_COLOR_TOLERANCE,
  withinTolerance,
  type JobProcessor,
  type MediaAdmin,
  type ModelManifest,
  type ModelOptimizer,
  type ModelProblem,
  type ModelStore,
  type ModelTexture,
  type ModelTextureEncoding,
  type OriginalRemover,
} from "@rikuy/core";

export interface ProcessModelDeps {
  readonly models: ModelStore;
  readonly optimizer: ModelOptimizer;
  readonly media: Pick<MediaAdmin, "readOriginal" | "storeDerivatives"> & OriginalRemover;
}

type TextureProgress = Omit<ModelTexture, "name" | "usage">;
/** What earlier attempts already encoded (the job's checkpoint), by texture index. */
type Progress = { readonly textures?: Readonly<Record<string, TextureProgress>> };

const workFile = (index: number) => `work/${index}.ktx2`;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readProgress(checkpoint: unknown): Progress {
  if (typeof checkpoint !== "object" || checkpoint === null) return {};
  return checkpoint as Progress;
}

/**
 * media.process_model (ADR-026): validates the GLB, encodes every texture to KTX2 for its use
 * (ETC1S; UASTC when ETC1S drifts too far; the original image when both do), compresses the
 * geometry with Meshopt and checks that materials and vertex colors are unchanged. The result
 * stays private next to the original, which is never modified.
 *
 * - Not a usable GLB, too complex, or too heavy once optimized → rejected with the reason and
 *   its original removed; no retry.
 * - Storage hiccups → transient: the ledger retries and the checkpoint (saved after each
 *   texture, whose KTX2 waits in `model/work/`) lets the next attempt skip what is done.
 */
export function createProcessModelProcessor(deps: ProcessModelDeps): JobProcessor {
  return {
    kind: JOB_KINDS.processModel,
    schemaVersions: [1],
    async run({ job, signal, saveCheckpoint }) {
      if (!processModelPayloadSchema.safeParse(job.payload).success) {
        throw permanentFailure("invalid_payload", "The job payload is not valid.");
      }
      const lease = { jobId: job.jobId, fencingToken: job.fencingToken };
      const lost = () => transientFailure("lease_lost", "The lease was lost.");
      const stopIfHalted = () => {
        if (signal.aborted) throw lost();
      };

      const source = await deps.models.source(lease);
      if (source === "lease_lost") throw lost();
      if (source === "not_found") return { result: { outcome: "not_found" } };
      if (source.status !== "processing") return { result: { outcome: "already_settled" } };

      const reject = async (problem: ModelProblem) => {
        await storage(() => deps.media.removeOriginal(source.originalPath));
        const rejected = await deps.models.reject(lease, problem);
        if (rejected === "lease_lost") throw lost();
        return { result: { outcome: "rejected", problem } };
      };

      const original = await storage(() => deps.media.readOriginal(source.originalPath));
      if (original === null) return reject("unreadable");
      if (original.byteLength > MODEL_LIMITS.maxBytes) return reject("too_heavy");
      if (!isGlb(original)) return reject("not_glb");

      let analysis: Awaited<ReturnType<ModelOptimizer["analyze"]>>;
      try {
        analysis = await deps.optimizer.analyze(original);
      } catch {
        return reject("unreadable");
      }
      if (!analysis.ok) return reject(analysis.problem);

      const folder = `${source.prefix}${MODEL_FOLDER}`;
      let progress = readProgress(job.checkpoint);
      const done = { ...progress.textures };

      for (const plan of analysis.textures) {
        stopIfHalted();
        if (done[plan.index]) continue;
        const kept: TextureProgress = {
          width: plan.width,
          height: plan.height,
          encoding: "original",
          bytes: plan.bytes,
          check: null,
        };
        let result = kept;
        if (plan.encodable) {
          for (const encoding of ["etc1s", "uastc"] as const) {
            let encoded: Awaited<ReturnType<ModelOptimizer["encodeTexture"]>>;
            try {
              encoded = await deps.optimizer.encodeTexture(original, plan.index, encoding);
            } catch {
              break; // The image cannot be re-encoded: it stays as uploaded.
            }
            if (!withinTolerance(encoded.check, TEXTURE_TOLERANCE[plan.usage])) continue;
            await storage(() =>
              deps.media.storeDerivatives(folder, [
                { name: workFile(plan.index), contentType: "image/ktx2", bytes: encoded.bytes },
              ]),
            );
            result = {
              width: encoded.width,
              height: encoded.height,
              encoding,
              bytes: encoded.bytes.byteLength,
              check: encoded.check,
            };
            break;
          }
        }
        done[plan.index] = result;
        progress = { ...progress, textures: { ...done } };
        await saveCheckpoint(progress);
      }
      stopIfHalted();

      const encoded = new Map<number, Uint8Array>();
      for (const plan of analysis.textures) {
        if ((done[plan.index]?.encoding ?? "original") === "original") continue;
        const bytes = await storage(() => deps.media.readOriginal(folder + workFile(plan.index)));
        // Gone (removed by hand?): encode it again on the next attempt.
        if (bytes === null)
          throw transientFailure("missing_progress", "An encoded texture is missing.");
        encoded.set(plan.index, bytes);
      }

      let assembled: Awaited<ReturnType<ModelOptimizer["assemble"]>>;
      try {
        assembled = await deps.optimizer.assemble(original, encoded);
      } catch {
        return reject("unreadable");
      }
      if (
        !assembled.materialsUnchanged ||
        (assembled.vertexColors && !withinTolerance(assembled.vertexColors, VERTEX_COLOR_TOLERANCE))
      ) {
        return reject("colors_changed");
      }
      const weight = modelWeight(assembled.glb.byteLength);
      if (weight === "too_heavy") return reject("too_heavy_optimized");

      await storage(() =>
        deps.media.storeDerivatives(folder, [
          { name: MODEL_FILE, contentType: "model/gltf-binary", bytes: assembled.glb },
        ]),
      );
      stopIfHalted();

      const sha256 = await sha256Hex(original);
      const manifest: ModelManifest = {
        version: MODEL_MANIFEST_VERSION,
        format: "glb",
        source: { ...analysis.source, bytes: original.byteLength, sha256 },
        model: {
          file: MODEL_FILE,
          bytes: assembled.glb.byteLength,
          triangles: assembled.triangles,
          geometry: "meshopt",
          textures: analysis.textures.map((plan) => ({
            name: plan.name,
            usage: plan.usage,
            ...(done[plan.index] ?? {
              width: plan.width,
              height: plan.height,
              encoding: "original" as ModelTextureEncoding,
              bytes: plan.bytes,
              check: null,
            }),
          })),
        },
        colors: {
          materials: "unchanged",
          vertexColors: assembled.vertexColors,
          suspects: [...analysis.suspects],
        },
        weight,
        poster: null,
      };
      const completed = await deps.models.complete(
        lease,
        { bytes: original.byteLength, sha256 },
        manifest,
      );
      if (completed === "lease_lost") throw lost();

      // The work files are not needed any more (best effort: they are private and small).
      for (const index of encoded.keys()) {
        await deps.media.removeOriginal(folder + workFile(index)).catch(() => undefined);
      }
      return {
        result: {
          outcome: completed,
          weight,
          bytes: assembled.glb.byteLength,
          suspects: analysis.suspects.length,
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
