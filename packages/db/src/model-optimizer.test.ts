import { readFileSync, writeFileSync } from "node:fs";

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { TEXTURE_TOLERANCE, VERTEX_COLOR_TOLERANCE, withinTolerance } from "@rikuy/core";
import { MeshoptDecoder } from "meshoptimizer";
import { describe, expect, it } from "vitest";

import { createGltfModelOptimizer } from "./model-optimizer";
import { syntheticModel as model } from "./testing/model-fixture";

async function optimize(original: Uint8Array) {
  const optimizer = createGltfModelOptimizer();
  const analysis = await optimizer.analyze(original);
  if (!analysis.ok) throw new Error(analysis.problem);
  const encoded = new Map<number, Uint8Array>();
  const checks: { usage: string; encoding: string; mean: number; p95: number }[] = [];
  // As the worker does: ETC1S, then UASTC, then the original image.
  for (const plan of analysis.textures) {
    for (const encoding of ["etc1s", "uastc"] as const) {
      const texture = await optimizer.encodeTexture(original, plan.index, encoding);
      if (withinTolerance(texture.check, TEXTURE_TOLERANCE[plan.usage])) {
        checks.push({ usage: plan.usage, encoding, ...texture.check });
        encoded.set(plan.index, texture.bytes);
        break;
      }
    }
  }
  return { analysis, checks, encoded, assembled: await optimizer.assemble(original, encoded) };
}

describe("GLB optimizer (ADR-026)", () => {
  it("classifies textures by use and reports a data map used as color", async () => {
    const analysis = await createGltfModelOptimizer().analyze(await model());
    expect(analysis.ok).toBe(true);
    if (!analysis.ok) return;
    expect(analysis.source).toMatchObject({ materials: 5, textures: 3 });
    // The mixed texture is split: a color copy (sRGB) and the data original (linear).
    expect(analysis.textures.map((t) => `${t.name}:${t.usage}`).sort()).toEqual([
      "Negro_metallicRoughness:color",
      "Negro_metallicRoughness:data",
      "Painted_baseColor:color",
      "Painted_normal:normal",
    ]);
    expect(analysis.suspects).toEqual([{ material: "Dorado", texture: "Negro_metallicRoughness" }]);
  }, 60_000);

  it("keeps colors: textures within tolerance, vertex colors and materials unchanged", async () => {
    const original = await model();
    const { checks, encoded, assembled } = await optimize(original);
    for (const check of checks) {
      expect(
        withinTolerance(check, TEXTURE_TOLERANCE[check.usage as "color"]),
        JSON.stringify(check),
      ).toBe(true);
    }
    expect(encoded.size).toBe(4);
    expect(assembled.materialsUnchanged).toBe(true);
    expect(assembled.vertexColors).not.toBeNull();
    expect(
      withinTolerance(assembled.vertexColors ?? { mean: 99, p95: 99 }, VERTEX_COLOR_TOLERANCE),
    ).toBe(true);

    await MeshoptDecoder.ready;
    const back = await new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ "meshopt.decoder": MeshoptDecoder })
      .readBinary(assembled.glb);
    const used = back
      .getRoot()
      .listExtensionsUsed()
      .map((extension) => extension.extensionName);
    expect(used).toEqual(expect.arrayContaining(["EXT_meshopt_compression", "KHR_texture_basisu"]));
    expect(used).not.toContain("KHR_draco_mesh_compression");
    expect(
      back
        .getRoot()
        .listTextures()
        .every((t) => t.getMimeType() === "image/ktx2"),
    ).toBe(true);
    expect(assembled.triangles).toBe(5 * 40 * 40 * 2);
  }, 120_000);

  it("decodes Draco input and rewrites it with Meshopt", async () => {
    const { assembled } = await optimize(await model({ draco: true }));
    expect(assembled.materialsUnchanged).toBe(true);
    expect(assembled.vertexColors?.p95).toBeLessThanOrEqual(VERTEX_COLOR_TOLERANCE.p95);
  }, 120_000);

  it("keeps an original texture when KTX2 is left out", async () => {
    const original = await model();
    const optimizer = createGltfModelOptimizer();
    const assembled = await optimizer.assemble(original, new Map());
    expect(assembled.materialsUnchanged).toBe(true);
  }, 60_000);

  it("refuses files it should not process", async () => {
    const optimizer = createGltfModelOptimizer();
    expect(await optimizer.analyze(new Uint8Array([1, 2, 3, 4]))).toEqual({
      ok: false,
      problem: "not_glb",
    });
    expect(await optimizer.analyze(await model({ externalImage: true }))).toEqual({
      ok: false,
      problem: "external_files",
    });
    expect(await optimizer.analyze(await model({ extension: "ACME_secret_sauce" }))).toEqual({
      ok: false,
      problem: "unsupported_extension",
    });
    const truncated = (await model()).slice(0, 4000);
    new DataView(truncated.buffer).setUint32(8, truncated.byteLength, true);
    expect((await optimizer.analyze(truncated)).ok).toBe(false);
  }, 60_000);

  // A real model, outside the repository: RIKUY_REAL_GLB=/path/model.glb pnpm test
  it.runIf(Boolean(process.env.RIKUY_REAL_GLB))(
    "optimizes a real model keeping its colors",
    async () => {
      const original = new Uint8Array(readFileSync(process.env.RIKUY_REAL_GLB ?? ""));
      const started = performance.now();
      const { analysis, checks, encoded, assembled } = await optimize(original);
      // Written next to the model (vitest keeps console output quiet).
      writeFileSync(
        `${process.env.RIKUY_REAL_GLB}.report.json`,
        JSON.stringify(
          {
            seconds: Math.round((performance.now() - started) / 1000),
            bytes: [original.byteLength, assembled.glb.byteLength],
            suspects: analysis.ok ? analysis.suspects : null,
            encoded: encoded.size,
            checks,
            vertexColors: assembled.vertexColors,
          },
          null,
          1,
        ),
      );
      expect(assembled.materialsUnchanged).toBe(true);
    },
    300_000,
  );
});
