/**
 * Automatic color comparison of the GLB pipeline in a real browser (ADR-026): the original
 * and the optimized file, drawn by three.js with the viewer's settings from the same camera,
 * must look the same. Runs the real processor (media.process_model) with the real
 * optimizer; only the ledger and Storage are in memory.
 *
 *   pnpm --filter @rikuy/web test:e2e-models
 *   RIKUY_REAL_GLB=/path/model.glb … also compares a real model (never committed).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import {
  deltaE,
  drainJobs,
  srgbToLab,
  summarizeDifferences,
  type DerivedFile,
  type ModelManifest,
} from "@rikuy/core";
import { createMemoryJobLedger } from "@rikuy/core/testing";
import { syntheticModel } from "@rikuy/db/testing";
import { createGltfModelOptimizer } from "@rikuy/db/worker";
import { createProcessModelProcessor } from "@rikuy/worker";
import { chromium, type Browser } from "playwright-core";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const THREE_ROOT = join(dirname(require.resolve("three")), "..");
const PAGE = join(dirname(fileURLToPath(import.meta.url)), "model-colors", "index.html");
const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

/** The real processor over an in-memory ledger and Storage: what production would write. */
async function optimizeAsProduction(original: Uint8Array) {
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

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".glb": "model/gltf-binary",
};

function serve(models: Map<string, Uint8Array>): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://x").pathname;
    let body: Uint8Array | null = null;
    if (path === "/") body = readFileSync(PAGE);
    else if (path.startsWith("/models/"))
      body = models.get(path.slice(8).replace(/\.glb$/u, "")) ?? null;
    else if (path.startsWith("/three/")) {
      const file = normalize(join(THREE_ROOT, path.slice(7)));
      if (file.startsWith(THREE_ROOT)) body = readFileSync(file, { flag: "r" });
    }
    if (!body) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": TYPES[extname(path)] ?? "text/html" }).end(body);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        origin: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`,
      });
    }),
  );
}

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({
    executablePath: CHROME,
    // Software WebGL (SwiftShader): the same pixels on any CI runner.
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
});
afterAll(async () => {
  await browser?.close();
});

async function draw(
  origin: string,
  model: string,
): Promise<{ data: Uint8Array; width: number; height: number }> {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/?model=${model}`);
    await page.waitForFunction(() => "__result" in window, null, { timeout: 60_000 });
    const result = (await page.evaluate(
      () => (window as unknown as { __result: unknown }).__result,
    )) as { ok: true; pixels: string } | { ok: false; error: string };
    if (!result.ok) throw new Error(`${model}: ${result.error}`);
    const png = Buffer.from(result.pixels.split(",")[1] ?? "", "base64");
    // Compared at a quarter of the size: sub-pixel edge shifts from quantization are not colors.
    const { data, info } = await sharp(png)
      .resize(160, 120, { kernel: "cubic" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(data), width: info.width, height: info.height };
  } finally {
    await page.close();
  }
}

/** How much of the frame is drawn, and how colorful it is (a black render would fail). */
function coverage(raster: { data: Uint8Array }) {
  let drawn = 0;
  let chroma = 0;
  for (let i = 0; i < raster.data.length; i += 4) {
    if ((raster.data[i + 3] ?? 0) < 128) continue;
    drawn += 1;
    const r = raster.data[i] ?? 0;
    const g = raster.data[i + 1] ?? 0;
    const b = raster.data[i + 2] ?? 0;
    chroma += Math.max(r, g, b) - Math.min(r, g, b);
  }
  return { drawn: drawn / (raster.data.length / 4), chroma: drawn ? chroma / drawn : 0 };
}

/**
 * ΔE of the surfaces' colors: only pixels drawn in both frames with their whole neighborhood
 * drawn too. Outlines move by a sub-pixel when the geometry is quantized; that is not color.
 */
function surfaceDrift(
  a: { data: Uint8Array; width: number; height: number },
  b: { data: Uint8Array },
) {
  const solid = (raster: Uint8Array, x: number, y: number) =>
    (raster[(y * a.width + x) * 4 + 3] ?? 0) === 255;
  const differences: number[] = [];
  for (let y = 1; y < a.height - 1; y += 1) {
    for (let x = 1; x < a.width - 1; x += 1) {
      let inside = true;
      for (let dy = -1; dy <= 1 && inside; dy += 1) {
        for (let dx = -1; dx <= 1 && inside; dx += 1) {
          inside = solid(a.data, x + dx, y + dy) && solid(b.data, x + dx, y + dy);
        }
      }
      if (!inside) continue;
      const i = (y * a.width + x) * 4;
      const lab = (raster: Uint8Array) =>
        srgbToLab((raster[i] ?? 0) / 255, (raster[i + 1] ?? 0) / 255, (raster[i + 2] ?? 0) / 255);
      differences.push(deltaE(lab(a.data), lab(b.data)));
    }
  }
  return { ...summarizeDifferences(differences), pixels: differences.length };
}

async function compare(original: Uint8Array) {
  const { optimized, manifest } = await optimizeAsProduction(original);
  const { server, origin } = await serve(
    new Map([
      ["original", original],
      ["optimized", optimized],
    ]),
  );
  try {
    const before = await draw(origin, "original");
    const after = await draw(origin, "optimized");
    return { manifest, before, after, drift: surfaceDrift(before, after) };
  } finally {
    server.close();
  }
}

describe.runIf(Boolean(process.env.CI) || process.env.RIKUY_MODEL_E2E === "1")(
  "GLB colors in a real browser (ADR-026)",
  () => {
    // Without the "data map used as color" mistake: with it, three.js reads the shared texture
    // as sRGB for both uses, and the optimized file (which splits it) draws the data correctly,
    // i.e. differently from the original. That case is covered by the optimizer's unit tests.
    it("draws the optimized model like the original", async () => {
      const { manifest, before, after, drift } = await compare(
        await syntheticModel({ dataAsColor: false }),
      );
      // RIKUY_MODEL_E2E_OUT=/path/compare.png keeps both frames and the manifest, to look at.
      if (process.env.RIKUY_MODEL_E2E_OUT) {
        await sharp(Buffer.concat([Buffer.from(before.data), Buffer.from(after.data)]), {
          raw: { width: before.width, height: before.height * 2, channels: 4 },
        })
          .png()
          .toFile(process.env.RIKUY_MODEL_E2E_OUT);
        writeFileSync(
          `${process.env.RIKUY_MODEL_E2E_OUT}.json`,
          JSON.stringify({ drift, manifest }, null, 1),
        );
      }
      expect(manifest.model.textures.every((texture) => texture.encoding !== "original")).toBe(
        true,
      );
      // Something colorful is on screen (not an empty or black frame).
      expect(coverage(before).drawn).toBeGreaterThan(0.05);
      expect(coverage(before).chroma).toBeGreaterThan(20);
      expect(coverage(after)).toMatchObject({ drawn: expect.closeTo(coverage(before).drawn, 1) });
      expect(drift.pixels).toBeGreaterThan(500);
      expect(drift.mean, JSON.stringify(drift)).toBeLessThanOrEqual(2);
      expect(drift.p95, JSON.stringify(drift)).toBeLessThanOrEqual(5);
    }, 300_000);

    it.runIf(Boolean(process.env.RIKUY_REAL_GLB))(
      "keeps the colors of a real model",
      async () => {
        const original = new Uint8Array(readFileSync(process.env.RIKUY_REAL_GLB ?? ""));
        const { before, after, drift } = await compare(original);
        await sharp(Buffer.concat([Buffer.from(before.data), Buffer.from(after.data)]), {
          raw: { width: before.width, height: before.height * 2, channels: 4 },
        })
          .png()
          .toFile(`${process.env.RIKUY_REAL_GLB}.compare.png`);
        expect(drift.mean, JSON.stringify(drift)).toBeLessThanOrEqual(2);
      },
      300_000,
    );
  },
);
