/**
 * Shared by the browser checks that need a model as production writes it (the GLB color
 * check and RC-08 in the tour): the real processor (media.process_model) with the real
 * optimizer over an in-memory ledger and Storage. No database, no secrets.
 */
import { drainJobs, type DerivedFile, type ModelManifest } from "@rikuy/core";
import { createMemoryJobLedger } from "@rikuy/core/testing";
import { createGltfModelOptimizer } from "@rikuy/db/worker";
import { createProcessModelProcessor } from "@rikuy/worker";

/** The real processor over an in-memory ledger and Storage: what production would write. */
export async function optimizeAsProduction(original: Uint8Array) {
  const files = new Map<string, Uint8Array>([["t/a/1/original", original]]);
  let manifest: ModelManifest | null = null;
  const processor = createProcessModelProcessor({
    optimizer: createGltfModelOptimizer(),
    models: {
      source: async () => ({
        status: "processing",
        originalPath: "t/a/1/original",
        declaredMime: "model/gltf-binary",
        prefix: "t/a/1/",
      }),
      complete: async (_lease, _original, written) => {
        manifest = written;
        return "ready";
      },
      reject: async (_lease, problem) => {
        throw new Error(`rejected: ${problem}`);
      },
    },
    media: {
      readOriginal: async (path) => files.get(path) ?? null,
      storeDerivatives: async (prefix, written: readonly DerivedFile[]) => {
        for (const file of written) files.set(prefix + file.name, file.bytes);
      },
      removeOriginal: async (path) => {
        files.delete(path);
      },
    },
  });
  const ledger = createMemoryJobLedger();
  ledger.add({
    jobId: "j",
    kind: "media.process_model",
    payload: { versionId: "5eed3000-0000-4000-8000-000000000099" },
  });
  await drainJobs({ ledger, processors: [processor], runnerId: "e2e", budgetMs: 280_000 });
  const optimized = files.get("t/a/1/model/model.glb");
  if (!optimized || !manifest)
    throw new Error(`not optimized: ${JSON.stringify(ledger.jobs.get("j"))}`);
  return { optimized, manifest: manifest as ModelManifest };
}
