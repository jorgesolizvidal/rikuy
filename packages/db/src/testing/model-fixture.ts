// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- see model-optimizer.ts
/// <reference path="../gltf-modules.d.ts" />
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { draco } from "@gltf-transform/functions";
import draco3d from "draco3dgltf";
import sharp from "sharp";

/**
 * A model with what usually loses its color: vertex colors, a painted sRGB texture, plain
 * colored materials, a normal map, and one texture used as color by one material and as
 * metal/roughness by another (found in a real municipal model).
 */
export async function syntheticModel(
  options: {
    draco?: boolean;
    externalImage?: boolean;
    extension?: string;
    /** Include the authoring mistake (a metal/roughness map used as color). Default: yes. */
    dataAsColor?: boolean;
  } = {},
) {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene("Scene");
  const n = 40;
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= n; i += 1) {
    for (let j = 0; j <= n; j += 1) {
      const t = (i / n) * Math.PI;
      const p = (j / n) * 2 * Math.PI;
      positions.push(Math.sin(t) * Math.cos(p), Math.cos(t), Math.sin(t) * Math.sin(p));
      uvs.push(j / n, i / n);
      const band = Math.floor((i / n) * 6) % 3;
      colors.push(band === 0 ? 0.8 : 0.05, band === 1 ? 0.6 : 0.05, band === 2 ? 0.7 : 0.05, 1);
    }
  }
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const a = i * (n + 1) + j;
      const b = a + n + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const accessor = (type: "VEC2" | "VEC3" | "VEC4", values: number[]) =>
    document.createAccessor().setType(type).setArray(new Float32Array(values)).setBuffer(buffer);
  const primitive = (material: ReturnType<Document["createMaterial"]>, vertexColors: boolean) => {
    const prim = document
      .createPrimitive()
      .setMaterial(material)
      .setAttribute("POSITION", accessor("VEC3", positions))
      .setAttribute("NORMAL", accessor("VEC3", positions))
      .setAttribute("TEXCOORD_0", accessor("VEC2", uvs))
      .setIndices(
        document
          .createAccessor()
          .setType("SCALAR")
          .setArray(new Uint32Array(indices))
          .setBuffer(buffer),
      );
    if (vertexColors) prim.setAttribute("COLOR_0", accessor("VEC4", colors));
    return prim;
  };

  const size = 256;
  const painted = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const stripe = [
        [200, 40, 30],
        [240, 190, 40],
        [30, 120, 60],
        [40, 70, 180],
      ][Math.floor(x / 32) % 4] ?? [0, 0, 0];
      const shade = 0.6 + 0.4 * (y / size);
      painted.set(
        stripe.map((value) => Math.round(value * shade)),
        (y * size + x) * 3,
      );
    }
  }
  const png = async (raw: Buffer) =>
    new Uint8Array(
      await sharp(raw, { raw: { width: size, height: size, channels: 3 } })
        .png()
        .toBuffer(),
    );
  const roughness = Buffer.alloc(size * size * 3);
  for (let i = 0; i < roughness.length; i += 3) roughness.set([255, 90 + ((i / 3) % 80), 180], i);
  const normal = Buffer.alloc(size * size * 3);
  for (let i = 0; i < normal.length; i += 3) normal.set([128 + ((i / 3) % 20), 128, 250], i);

  const base = document
    .createTexture("Painted_baseColor")
    .setMimeType("image/png")
    .setImage(await png(painted));
  const metalRough = document
    .createTexture("Negro_metallicRoughness")
    .setMimeType("image/png")
    .setImage(await png(roughness));
  const normalMap = document
    .createTexture("Painted_normal")
    .setMimeType("image/png")
    .setImage(await png(normal));

  const materials = [
    document.createMaterial("Painted").setBaseColorTexture(base).setNormalTexture(normalMap),
    document.createMaterial("VertexColor"),
    document
      .createMaterial("Brass")
      .setBaseColorFactor([0.8, 0.55, 0.2, 1])
      .setMetallicFactor(1)
      .setRoughnessFactor(0.35)
      .setEmissiveFactor([0.1, 0.02, 0]),
    document
      .createMaterial("Negro")
      .setMetallicRoughnessTexture(metalRough)
      .setOcclusionTexture(metalRough),
    // The mistake: a metal/roughness map used as color (or, without it, a plain gold).
    options.dataAsColor === false
      ? document.createMaterial("Dorado").setBaseColorFactor([0.83, 0.69, 0.22, 1])
      : document.createMaterial("Dorado").setBaseColorTexture(metalRough),
  ];
  materials.forEach((material, index) => {
    const mesh = document
      .createMesh(material.getName())
      .addPrimitive(primitive(material, index === 1));
    scene.addChild(
      document
        .createNode(material.getName())
        .setMesh(mesh)
        .setTranslation([index * 2.5, 0, 0]),
    );
  });
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    "draco3d.encoder": await draco3d.createEncoderModule(),
    "draco3d.decoder": await draco3d.createDecoderModule(),
  });
  if (options.draco) await document.transform(draco());
  const glb = await io.writeBinary(document);
  let out: Uint8Array = glb;
  if (options.extension) {
    const name = options.extension;
    out = rewriteJson(out, (json) => {
      json.extensionsUsed = [...(json.extensionsUsed ?? []), name];
      json.extensionsRequired = [...(json.extensionsRequired ?? []), name];
    });
  }
  if (options.externalImage) {
    out = rewriteJson(out, (json) => {
      const image = json.images?.[0];
      if (image) {
        delete image.bufferView;
        image.uri = "textures/painted.png";
      }
    });
  }
  return out;
}

type GltfJson = Record<string, unknown> & {
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  images?: Record<string, unknown>[];
};

/** Rewrites the JSON chunk of a GLB. */
function rewriteJson(glb: Uint8Array, change: (json: GltfJson) => void): Uint8Array {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const length = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length))) as GltfJson;
  change(json);
  let text = JSON.stringify(json);
  while (text.length % 4 !== 0) text += " ";
  const jsonBytes = new TextEncoder().encode(text);
  const rest = glb.subarray(20 + length);
  const out = new Uint8Array(20 + jsonBytes.length + rest.length);
  const outView = new DataView(out.buffer);
  out.set(glb.subarray(0, 12));
  outView.setUint32(8, out.length, true);
  outView.setUint32(12, jsonBytes.length, true);
  outView.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  out.set(rest, 20 + jsonBytes.length);
  return out;
}
