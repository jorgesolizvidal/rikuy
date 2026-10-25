// The WASM packages ship no types; their declarations travel with this module, also when
// another package (apps/web) compiles it.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./gltf-modules.d.ts" />
import {
  NodeIO,
  type Document,
  type Material,
  type Node,
  type Primitive,
  type Texture,
} from "@gltf-transform/core";
import {
  ALL_EXTENSIONS,
  EXTMeshoptCompression,
  EXTTextureWebP,
  KHRDracoMeshCompression,
  KHRTextureBasisu,
} from "@gltf-transform/extensions";
import { dedup, meshopt, prune, weld } from "@gltf-transform/functions";
import {
  linearToSrgb,
  manifestLabel,
  MODEL_LIMITS,
  rasterDeltaE,
  srgbToLab,
  deltaE,
  summarizeDifferences,
  type AssembledModel,
  type ColorCheck,
  type ColorSuspect,
  type EncodedTexture,
  type ModelAnalysis,
  type ModelOptimizer,
  type ModelProblem,
  type ModelTexturePlan,
  type ModelTextureUsage,
} from "@rikuy/core";
import draco3d from "draco3dgltf";
import { validateBytes } from "gltf-validator";
import * as ktx2 from "ktx2-encoder";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import sharp from "sharp";

/**
 * The GLB pipeline (ADR-026), all in WebAssembly/JS so it runs in a Vercel function:
 * glTF Transform to read and write, the Khronos validator, Draco/Meshopt decoders, Meshopt
 * geometry compression and Basis Universal (KTX2) textures. Every texture is encoded for
 * its use (sRGB color, linear data, normal maps) and checked by decoding it again.
 *
 * The file is "prepared" the same way in every call (decode, dedup, prune keeping
 * attributes and solid textures, split textures used both as color and as data), so texture
 * indices are stable across attempts and the worker can checkpoint per texture.
 */

/** Extensions three.js and glTF Transform both handle; a required one outside → rejected. */
const SUPPORTED_EXTENSIONS = new Set([
  "KHR_draco_mesh_compression",
  "EXT_meshopt_compression",
  "KHR_mesh_quantization",
  "KHR_texture_basisu",
  "EXT_texture_webp",
  "EXT_texture_avif",
  "KHR_texture_transform",
  "KHR_materials_emissive_strength",
  "KHR_materials_clearcoat",
  "KHR_materials_transmission",
  "KHR_materials_volume",
  "KHR_materials_ior",
  "KHR_materials_specular",
  "KHR_materials_sheen",
  "KHR_materials_unlit",
  "KHR_materials_iridescence",
  "KHR_materials_anisotropy",
  "KHR_materials_dispersion",
  "KHR_materials_variants",
  "KHR_lights_punctual",
  "EXT_mesh_gpu_instancing",
]);

/** Texture slots read as sRGB color; everything else (but normals) is linear data. */
const COLOR_SLOTS = new Set([
  "baseColorTexture",
  "emissiveTexture",
  "sheenColorTexture",
  "specularColorTexture",
]);
const ENCODABLE = new Set(["image/png", "image/jpeg", "image/webp"]);

// ── Readers ─────────────────────────────────────────────────────────────────

let ioPromise: Promise<NodeIO> | undefined;
function io(): Promise<NodeIO> {
  ioPromise ??= (async () => {
    await MeshoptDecoder.ready;
    await MeshoptEncoder.ready;
    return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
      "draco3d.decoder": await draco3d.createDecoderModule(),
      "meshopt.decoder": MeshoptDecoder,
      "meshopt.encoder": MeshoptEncoder,
    });
  })();
  return ioPromise;
}

// TypeScript resolves the package's browser types; Node (our only runtime) loads its "node"
// export, which also has the module loader we need for decoding.
const { NodeBasisEncoder } = ktx2 as unknown as {
  NodeBasisEncoder: new () => {
    init(): Promise<unknown>;
    encode(
      image: Uint8Array,
      options: Parameters<typeof ktx2.encodeToKTX2>[1],
    ): Promise<Uint8Array>;
  };
};

/**
 * One Basis module encodes and decodes. It prints a dozen lines per texture to stdout and
 * Emscripten binds `console.log` when the module starts, so it starts with a silent one
 * (errors still go to stderr): the logs keep only our JSON events.
 */
const basisEncoder = new NodeBasisEncoder();
let basisPromise: Promise<BasisModule> | undefined;
function basis(): Promise<BasisModule> {
  basisPromise ??= (async () => {
    /* eslint-disable no-console -- silencing Basis' stdout, see above */
    const log = console.log;
    console.log = () => undefined;
    try {
      return (await basisEncoder.init()) as BasisModule;
    } finally {
      console.log = log;
    }
    /* eslint-enable no-console */
  })();
  return basisPromise;
}

async function encodeToKTX2(
  image: Uint8Array,
  options: Parameters<typeof ktx2.encodeToKTX2>[1],
): Promise<Uint8Array> {
  await basis();
  (globalThis as { __KTX2_DEBUG__?: boolean }).__KTX2_DEBUG__ = false;
  return basisEncoder.encode(image, options);
}

interface BasisModule {
  KTX2File: new (bytes: Uint8Array) => {
    isValid(): boolean;
    startTranscoding(): boolean;
    getWidth(): number;
    getHeight(): number;
    getImageTranscodedSizeInBytes(
      level: number,
      layer: number,
      face: number,
      format: number,
    ): number;
    transcodeImage(
      dst: Uint8Array,
      level: number,
      layer: number,
      face: number,
      format: number,
      flags: number,
      channel0: number,
      channel1: number,
    ): boolean;
    close(): void;
    delete(): void;
  };
  transcoder_texture_format: { cTFRGBA32: { value: number } };
}

interface GlbJson {
  readonly asset?: { readonly version?: unknown; readonly generator?: unknown };
  readonly extensionsUsed?: unknown;
  readonly extensionsRequired?: unknown;
  readonly buffers?: readonly { readonly uri?: unknown }[];
  readonly images?: readonly { readonly uri?: unknown }[];
  readonly materials?: readonly unknown[];
  readonly textures?: readonly unknown[];
}

/** The JSON chunk of a GLB, read before anything else touches the file. */
function glbJson(bytes: Uint8Array): GlbJson | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) return null;
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || 20 + length > bytes.byteLength) return null;
  try {
    const json: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
    return json && typeof json === "object" ? (json as GlbJson) : null;
  } catch {
    return null;
  }
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Problems visible in the file's JSON alone: version, external files, extensions. */
function precheck(json: GlbJson): ModelProblem | null {
  if (json.asset?.version !== "2.0") return "invalid_model";
  const external = [...(json.buffers ?? []), ...(json.images ?? [])].some(
    (entry) => typeof entry.uri === "string" && !entry.uri.startsWith("data:"),
  );
  if (external) return "external_files";
  if (strings(json.extensionsRequired).some((name) => !SUPPORTED_EXTENSIONS.has(name))) {
    return "unsupported_extension";
  }
  return null;
}

// ── Preparation (identical in every call) ──────────────────────────────────

function slotsOf(document: Document, texture: Texture): string[] {
  const root = document.getRoot();
  return [
    ...new Set(
      texture
        .getGraph()
        .listParentEdges(texture)
        .filter((edge) => edge.getParent() !== root)
        .map((edge) => edge.getName()),
    ),
  ];
}

function usageOf(slots: readonly string[]): ModelTextureUsage {
  if (slots.some((slot) => COLOR_SLOTS.has(slot))) return "color";
  return slots.includes("normalTexture") ? "normal" : "data";
}

interface Prepared {
  readonly document: Document;
  readonly suspects: ColorSuspect[];
}

/**
 * A texture used both as color (sRGB) and as data (linear) by different materials is split:
 * KTX2 stores one transfer function per texture. The material using it as color is
 * reported: a data map as a color is almost always an authoring mistake.
 */
function splitMixedTextures(document: Document): ColorSuspect[] {
  const suspects: ColorSuspect[] = [];
  for (const texture of document.getRoot().listTextures()) {
    const slots = slotsOf(document, texture);
    if (!slots.some((slot) => COLOR_SLOTS.has(slot))) continue;
    if (!slots.some((slot) => !COLOR_SLOTS.has(slot))) continue;
    const copy = texture.clone().setName(texture.getName());
    for (const material of document.getRoot().listMaterials()) {
      const usedAsColor =
        material.getBaseColorTexture() === texture || material.getEmissiveTexture() === texture;
      if (material.getBaseColorTexture() === texture) material.setBaseColorTexture(copy);
      if (material.getEmissiveTexture() === texture) material.setEmissiveTexture(copy);
      if (usedAsColor) {
        suspects.push({
          material: manifestLabel(material.getName(), "Material sin nombre"),
          texture: manifestLabel(texture.getName(), "Textura sin nombre"),
        });
      }
    }
  }
  return suspects.slice(0, 32);
}

async function prepare(original: Uint8Array): Promise<Prepared> {
  const document = await (await io()).readBinary(original);
  // Decoded on read: the output is written with Meshopt only.
  for (const extension of document.getRoot().listExtensionsUsed()) {
    if (
      extension instanceof KHRDracoMeshCompression ||
      extension instanceof EXTMeshoptCompression
    ) {
      extension.dispose();
    }
  }
  await document.transform(
    dedup(),
    // Conservative: never drop vertex attributes (vertex colors!) or turn textures into factors.
    prune({ keepAttributes: true, keepSolidTextures: true, keepExtras: true }),
  );
  return { document, suspects: splitMixedTextures(document) };
}

/** Same file object in the same attempt → prepared once (encodeTexture is called per texture). */
const prepared = new WeakMap<Uint8Array, Promise<Prepared>>();
function preparedOnce(original: Uint8Array): Promise<Prepared> {
  let entry = prepared.get(original);
  if (!entry) {
    entry = prepare(original);
    prepared.set(original, entry);
  }
  return entry;
}

function geometryCounts(document: Document): { triangles: number; vertices: number } {
  let triangles = 0;
  let vertices = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const count = primitive.getAttribute("POSITION")?.getCount() ?? 0;
      vertices += count;
      if (primitive.getMode() === 4) {
        triangles += Math.floor((primitive.getIndices()?.getCount() ?? count) / 3);
      }
    }
  }
  return { triangles, vertices };
}

// ── Texture checks ─────────────────────────────────────────────────────────

interface Raster {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

async function decodeKtx2(bytes: Uint8Array): Promise<Raster> {
  const module = await basis();
  const file = new module.KTX2File(bytes);
  try {
    if (!file.isValid() || !file.startTranscoding()) throw new Error("Invalid KTX2 output");
    const format = module.transcoder_texture_format.cTFRGBA32.value;
    const data = new Uint8Array(file.getImageTranscodedSizeInBytes(0, 0, 0, format));
    if (!file.transcodeImage(data, 0, 0, 0, format, 0, -1, -1)) throw new Error("KTX2 transcode");
    return { data, width: file.getWidth(), height: file.getHeight() };
  } finally {
    file.close();
    file.delete();
  }
}

/** Both rasters at the same small size (what an eye sees as the color of each region). */
async function comparable(raster: Raster, size: number): Promise<Uint8Array> {
  const { data } = await sharp(raster.data, {
    raw: { width: raster.width, height: raster.height, channels: 4 },
  })
    .resize(size, size, { fit: "fill", kernel: "cubic" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return new Uint8Array(data);
}

/** How far the encoded texture drifted, in the unit of its use. */
async function measure(
  source: Raster,
  encoded: Raster,
  usage: ModelTextureUsage,
): Promise<ColorCheck> {
  const size = Math.min(128, source.width, source.height);
  const a = await comparable(source, size);
  const b = await comparable(encoded, size);
  if (usage === "color") {
    const color = rasterDeltaE(a, b, 4);
    // Alpha (cut-outs, glass) counts as data: 0–255.
    const alpha: number[] = [];
    for (let i = 3; i < a.length; i += 4) alpha.push(Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
    const alphaCheck = summarizeDifferences(alpha);
    return alphaCheck.p95 > 12 ? { mean: Math.max(color.mean, 99), p95: 99 } : color;
  }
  const differences: number[] = [];
  for (let i = 0; i < a.length; i += 4) {
    if (usage === "normal") {
      const vector = (raster: Uint8Array) => {
        const x = (raster[i] ?? 0) / 127.5 - 1;
        const y = (raster[i + 1] ?? 0) / 127.5 - 1;
        const z = (raster[i + 2] ?? 0) / 127.5 - 1;
        const length = Math.hypot(x, y, z) || 1;
        return [x / length, y / length, z / length] as const;
      };
      const [ax, ay, az] = vector(a);
      const [bx, by, bz] = vector(b);
      const cosine = Math.min(1, Math.max(-1, ax * bx + ay * by + az * bz));
      differences.push((Math.acos(cosine) * 180) / Math.PI);
    } else {
      for (let c = 0; c < 3; c += 1) differences.push(Math.abs((a[i + c] ?? 0) - (b[i + c] ?? 0)));
    }
  }
  return summarizeDifferences(differences);
}

// ── Model checks ───────────────────────────────────────────────────────────

/** Primitives in scene order, with the world matrix of their node. */
function primitivesOf(document: Document) {
  const result: { key: string; node: Node; primitive: Primitive }[] = [];
  const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
  let order = 0;
  scene?.traverse((node) => {
    const mesh = node.getMesh();
    if (!mesh) return;
    mesh.listPrimitives().forEach((primitive, index) => {
      result.push({ key: `${order}:${index}`, node, primitive });
    });
    order += 1;
  });
  return result;
}

const round = (value: number) => Math.round(value * 1e4) / 1e4;

function materialSignature(material: Material | null): string {
  if (!material) return "none";
  return JSON.stringify([
    material.getBaseColorFactor().map(round),
    material.getEmissiveFactor().map(round),
    round(material.getMetallicFactor()),
    round(material.getRoughnessFactor()),
    material.getAlphaMode(),
    round(material.getAlphaCutoff()),
    material.getDoubleSided(),
    Boolean(material.getBaseColorTexture()),
    Boolean(material.getEmissiveTexture()),
    Boolean(material.getNormalTexture()),
    Boolean(material.getMetallicRoughnessTexture()),
    Boolean(material.getOcclusionTexture()),
    material
      .listExtensions()
      .map((extension) => extension.extensionName)
      .sort(),
  ]);
}

/** Vertex positions in world space and their colors (sRGB 0–1), sampled. */
function coloredVertices(node: Node, primitive: Primitive) {
  const position = primitive.getAttribute("POSITION");
  const color = primitive.getAttribute("COLOR_0");
  if (!position || !color) return null;
  const matrix = node.getWorldMatrix();
  const count = position.getCount();
  const step = Math.max(1, Math.floor(count / 20_000));
  const points: { p: [number, number, number]; c: [number, number, number] }[] = [];
  const v: number[] = [];
  const c: number[] = [];
  for (let i = 0; i < count; i += step) {
    position.getElement(i, v);
    color.getElement(i, c);
    const [x = 0, y = 0, z = 0] = v;
    points.push({
      p: [
        matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
        matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
        matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
      ],
      c: [linearToSrgb(c[0] ?? 0), linearToSrgb(c[1] ?? 0), linearToSrgb(c[2] ?? 0)],
    });
  }
  return points;
}

/** For each output vertex, the color of the nearest original vertex (grid search). */
function vertexColorDrift(
  before: NonNullable<ReturnType<typeof coloredVertices>>,
  after: NonNullable<ReturnType<typeof coloredVertices>>,
): number[] {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const { p } of before) {
    for (let k = 0; k < 3; k += 1) {
      min[k] = Math.min(min[k] ?? 0, p[k] ?? 0);
      max[k] = Math.max(max[k] ?? 0, p[k] ?? 0);
    }
  }
  const diagonal = Math.hypot(...max.map((value, k) => value - (min[k] ?? 0))) || 1;
  const cell = diagonal / 200;
  const key = (p: readonly number[]) =>
    p.map((value, k) => Math.floor((value - (min[k] ?? 0)) / cell)).join(",");
  const grid = new Map<string, (typeof before)[number][]>();
  for (const point of before) {
    const k = key(point.p);
    const bucket = grid.get(k);
    if (bucket) bucket.push(point);
    else grid.set(k, [point]);
  }
  const drift: number[] = [];
  for (const point of after) {
    const [cx, cy, cz] = point.p.map((value, k) => Math.floor((value - (min[k] ?? 0)) / cell));
    let best: (typeof before)[number] | undefined;
    let bestDistance = Infinity;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          for (const candidate of grid.get(
            `${(cx ?? 0) + dx},${(cy ?? 0) + dy},${(cz ?? 0) + dz}`,
          ) ?? []) {
            const distance = Math.hypot(
              candidate.p[0] - point.p[0],
              candidate.p[1] - point.p[1],
              candidate.p[2] - point.p[2],
            );
            if (distance < bestDistance) {
              bestDistance = distance;
              best = candidate;
            }
          }
        }
      }
    }
    if (best) drift.push(deltaE(srgbToLab(...best.c), srgbToLab(...point.c)));
  }
  return drift;
}

// ── The optimizer ──────────────────────────────────────────────────────────

export function createGltfModelOptimizer(): ModelOptimizer {
  return {
    async analyze(original): Promise<ModelAnalysis> {
      const json = glbJson(original);
      if (json === null) return { ok: false, problem: "not_glb" };
      const problem = precheck(json);
      if (problem) return { ok: false, problem };

      const report = (await validateBytes(original, {
        maxIssues: 100,
        // A GLB that points outside itself was already refused; nothing is ever fetched.
        externalResourceFunction: () => Promise.reject(new Error("external resources")),
      })) as { issues: { numErrors: number } };
      if (report.issues.numErrors > 0) return { ok: false, problem: "invalid_model" };

      let document: Document;
      let suspects: ColorSuspect[];
      try {
        ({ document, suspects } = await preparedOnce(original));
      } catch {
        return { ok: false, problem: "unreadable" };
      }
      const { triangles, vertices } = geometryCounts(document);
      const textures = document.getRoot().listTextures();
      if (triangles > MODEL_LIMITS.maxTriangles || textures.length > MODEL_LIMITS.maxTextures) {
        return { ok: false, problem: "too_complex" };
      }

      const plans: ModelTexturePlan[] = textures.map((texture, index) => {
        const [width, height] = texture.getSize() ?? [0, 0];
        return {
          index,
          name: manifestLabel(texture.getName(), `Textura ${index + 1}`),
          usage: usageOf(slotsOf(document, texture)),
          width,
          height,
          bytes: texture.getImage()?.byteLength ?? 0,
          encodable: ENCODABLE.has(texture.getMimeType()) && width > 0 && height > 0,
        };
      });
      return {
        ok: true,
        source: {
          triangles,
          vertices,
          // As uploaded (before textures used both as color and data are split).
          materials: Array.isArray(json.materials) ? json.materials.length : 0,
          textures: Array.isArray(json.textures) ? json.textures.length : 0,
          generator:
            typeof json.asset?.generator === "string" ? json.asset.generator.slice(0, 120) : null,
          extensions: strings(json.extensionsUsed).slice(0, 32),
        },
        textures: plans,
        suspects,
      };
    },

    async encodeTexture(original, index, encoding): Promise<EncodedTexture> {
      const { document } = await preparedOnce(original);
      const texture = document.getRoot().listTextures()[index];
      const image = texture?.getImage();
      if (!texture || !image) throw new Error(`Texture ${index} not found`);
      const usage = usageOf(slotsOf(document, texture));

      // At most 2048 px per side (never enlarged): the encoder's limit and the phone's budget.
      const max = MODEL_LIMITS.textureMaxSide;
      const { data, info } = await sharp(image, { limitInputPixels: 16_384 * 16_384 })
        .resize(max, max, { fit: "inside", withoutEnlargement: true })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const source: Raster = { data: new Uint8Array(data), width: info.width, height: info.height };

      const bytes = await encodeToKTX2(new Uint8Array([0]), {
        imageDecoder: async () => source,
        isUASTC: encoding === "uastc",
        needSupercompression: true,
        generateMipmap: true,
        // Color is sRGB; normals and data maps are linear (the classic source of shifts).
        isPerceptual: usage === "color",
        isSetKTX2SRGBTransferFunc: usage === "color",
        isNormalMap: usage === "normal",
        qualityLevel: usage === "normal" ? 255 : 200,
        compressionLevel: 2,
      });
      const check = await measure(source, await decodeKtx2(bytes), usage);
      return { bytes, width: source.width, height: source.height, check };
    },

    async assemble(original, encoded): Promise<AssembledModel> {
      const reader = await io();
      // Fresh: this one is modified.
      const { document } = await prepare(original);
      const textures = document.getRoot().listTextures();
      let basisu = false;
      for (const [index, bytes] of encoded) {
        const texture = textures[index];
        if (!texture) throw new Error(`Texture ${index} not found`);
        texture.setImage(bytes).setMimeType("image/ktx2");
        basisu = true;
      }
      if (basisu) document.createExtension(KHRTextureBasisu).setRequired(true);
      if (!textures.some((texture) => texture.getMimeType() === "image/webp")) {
        for (const extension of document.getRoot().listExtensionsUsed()) {
          if (extension instanceof EXTTextureWebP) extension.dispose();
        }
      }
      await document.transform(
        weld(),
        // 10-bit vertex colors (Meshopt's default is 8): colors matter more than bytes here.
        meshopt({ encoder: MeshoptEncoder, level: "high", quantizeColor: 10 }),
      );
      const glb = await reader.writeBinary(document);

      // Check what was written against the original file as uploaded.
      const before = await reader.readBinary(original);
      const after = await reader.readBinary(glb);
      const beforePrimitives = primitivesOf(before);
      const afterPrimitives = primitivesOf(after);
      let materialsUnchanged = beforePrimitives.length === afterPrimitives.length;
      const drift: number[] = [];
      let hasVertexColors = false;
      for (let i = 0; materialsUnchanged && i < beforePrimitives.length; i += 1) {
        const a = beforePrimitives[i];
        const b = afterPrimitives[i];
        if (!a || !b || a.key !== b.key) {
          materialsUnchanged = false;
          break;
        }
        if (
          materialSignature(a.primitive.getMaterial()) !==
          materialSignature(b.primitive.getMaterial())
        ) {
          materialsUnchanged = false;
        }
        const colorsBefore = coloredVertices(a.node, a.primitive);
        const colorsAfter = coloredVertices(b.node, b.primitive);
        if (colorsBefore && !colorsAfter) materialsUnchanged = false;
        if (colorsBefore && colorsAfter) {
          hasVertexColors = true;
          drift.push(...vertexColorDrift(colorsBefore, colorsAfter));
        }
      }
      return {
        glb,
        triangles: geometryCounts(after).triangles,
        vertexColors: hasVertexColors ? summarizeDifferences(drift) : null,
        materialsUnchanged,
      };
    },
  };
}
