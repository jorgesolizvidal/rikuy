/**
 * RC-07 (P4 · Paso 4): a published tour in the portal, in a real browser, against the
 * production build (`next start`) and the local Supabase stack. CI job "Contracts", after
 * the Lighthouse budget (so the seed it measures stays as it is).
 *
 * The fixture is a tour of a new destination in Demo Sur, built with the same RPCs the
 * panel uses: three synthetic panoramas of distinct colors (the second one large enough for
 * tiles), points of the four kinds, two photos, a model with its poster and a second tour to
 * jump to. The files go straight to the public bucket, as a publication leaves them.
 *
 * The walk: destination → tour → entry → information and gallery → arrow → next → previous →
 * model → another tour → back. Fast taps and a late answer never bring an old scene back. A
 * browser without WebGL still has the whole tour as text.
 *
 *   SUPABASE_URL=… SUPABASE_SECRET_KEY=… SUPABASE_DB_URL=… pnpm --filter @rikuy/web test:e2e-tour
 */
import { randomUUID } from "node:crypto";

import { imageCandidates, planPanorama, type DerivedFile } from "@rikuy/core";
import { syntheticModel } from "@rikuy/db/testing";
import { createSharpPanoramaRenderer } from "@rikuy/db/worker";
import { chromium, type Browser, type Page } from "playwright-core";
import postgres from "postgres";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { optimizeAsProduction } from "./support/production-model";

const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = Number(process.env.RIKUY_PORT ?? 3000);
const PORTAL = `http://demo-sur.localhost:${PORT}`;
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SECRET = process.env.SUPABASE_SECRET_KEY ?? "";
const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SUR = "5eed1000-0000-4000-8000-000000000002";
const OWNER_SUR = "5eed0000-0000-4000-8000-000000000002";
const RUN = randomUUID().slice(0, 6);

type Rgb = readonly [number, number, number];
interface Scene {
  readonly key: string;
  readonly title: string;
  readonly color: Rgb;
  readonly width: number;
  versionId?: string;
  assetId?: string;
  sceneId?: string;
}

const SCENES: Record<string, Scene> = {
  a: { key: "a", title: "Patio de entrada", color: [205, 52, 44], width: 2048 },
  b: { key: "b", title: "Sala grande", color: [38, 150, 72], width: 8192 },
  c: { key: "c", title: "Taller", color: [44, 82, 196], width: 2048 },
  d: { key: "d", title: "Plaza", color: [222, 178, 40], width: 2048 },
};

/** A flat color with thin marks and a label: easy to recognize on screen. */
async function panoramaSource(scene: Scene): Promise<Uint8Array> {
  const width = scene.width;
  const height = width / 2;
  const [r, g, b] = scene.color;
  const marks = Array.from({ length: 8 }, (_, i) => {
    const x = (width / 8) * i;
    return `<rect x="${x}" y="0" width="${width / 400}" height="${height}" fill="rgb(255,255,255)" fill-opacity="0.35"/>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="rgb(${r},${g},${b})"/>${marks}
    <text x="${width * 0.2}" y="${height * 0.3}" font-size="${height / 10}" font-family="sans-serif" fill="white">${scene.title}</text>
  </svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer());
}

async function upload(path: string, bytes: Uint8Array, contentType: string) {
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/media-public/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      apikey: SECRET,
      "content-type": contentType,
      "cache-control": "max-age=31536000",
      "x-upsert": "true",
    },
    body: Buffer.from(bytes),
  });
  if (!response.ok) throw new Error(`upload ${path}: ${response.status} ${await response.text()}`);
}

async function uploadAll(prefix: string, files: readonly DerivedFile[]) {
  for (let start = 0; start < files.length; start += 12) {
    await Promise.all(
      files
        .slice(start, start + 12)
        .map((file) => upload(`${prefix}${file.name}`, file.bytes, file.contentType)),
    );
  }
}

function need(value: string | undefined): string {
  if (!value) throw new Error("fixture step missing");
  return value;
}

const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
const ids = { destination: "", other: "", tour: "", otherTour: "", slug: "", otherSlug: "" };
const points: Record<string, string> = {};
/** About 9 km apart: «cerca de ti» puts the museum first for a visitor next to it. */
const MUSEUM_AT = { lat: -17.41, lng: -66.12 };
const PLAZA_AT = { lat: -17.45, lng: -66.2 };
/** Between the two: by distance from the museum, it comes second. */
const CARNIVAL_AT = { lat: -17.43, lng: -66.16 };

/**
 * The reference tours of the audit (RC-07): a museum and a carnival. The carnival has four
 * scenes (the same synthetic panoramas in another order); the museum, three (the audit's has
 * two: the third is the large one, served as tiles).
 */
interface ReferenceTour {
  slug: string;
  title: string;
  tourId: string;
  /** In their published order; the first is the entry. Key: the panorama on screen. */
  scenes: { key: string; title: string; sceneId: string }[];
  /** A point with text and two photos, in the entry scene. */
  info: string;
}
const carnival: ReferenceTour = {
  slug: "",
  title: "Carnaval de prueba",
  tourId: "",
  scenes: [],
  info: "Comparsas y trajes",
};

/** A published panorama version: renditions (tiles too) in the public bucket and its row. */
async function publishPanorama(scene: Scene) {
  const renderer = createSharpPanoramaRenderer();
  const source = await panoramaSource(scene);
  const plan = planPanorama(scene.width);
  const asset = randomUUID();
  const version = randomUUID();
  const prefix = `${SUR}/${asset}/1/panorama/`;
  const preview = await renderer.preview(source, plan);
  const image = await renderer.image(source, plan);
  const files: DerivedFile[] = [preview.file, image.file];
  const levels = [];
  for (const [index, level] of (plan.levels ?? []).entries()) {
    const dir = `tiles/${index}`;
    const tiles = await renderer.tiles(source, level);
    files.push(...tiles.map((tile) => ({ ...tile, name: `${dir}/${tile.name}` })));
    levels.push({ ...level, dir });
  }
  await uploadAll(prefix, files);
  const manifest = {
    version: 1,
    projection: "equirectangular",
    source: {
      width: scene.width,
      height: scene.width / 2,
      bytes: source.byteLength,
      mime: "image/jpeg",
      sha256: "e".repeat(64),
    },
    preview: {
      file: "preview.webp",
      width: preview.width,
      height: preview.height,
      bytes: preview.file.bytes.byteLength,
    },
    image: {
      file: "image.webp",
      width: image.width,
      height: image.height,
      bytes: image.file.bytes.byteLength,
    },
    tiles: levels.length > 0 ? { tileSize: 512, format: "webp", levels } : null,
  };
  await db`insert into public.assets (id, tenant_id, purpose) values (${asset}, ${SUR}, 'panorama')`;
  await db`
    insert into public.asset_versions (id, tenant_id, asset_id, version, status, declared_mime, declared_bytes,
                                       mime, bytes, width, height, sha256, ready_at, published_at, manifest)
    values (${version}, ${SUR}, ${asset}, 1, 'ready', 'image/jpeg', ${source.byteLength}, 'image/jpeg',
            ${source.byteLength}, ${scene.width}, ${scene.width / 2}, ${"e".repeat(64)}, now(), now(),
            ${db.json(manifest)})`;
  scene.assetId = asset;
  scene.versionId = version;
}

async function publishPhoto(color: Rgb): Promise<{ assetId: string }> {
  const asset = randomUUID();
  const width = 1600;
  const height = 1200;
  const [r, g, b] = color;
  for (const candidate of imageCandidates(SUR, {
    assetId: asset,
    version: 1,
    alt: "",
    width,
    height,
  })) {
    const bytes = await sharp({
      create: {
        width: candidate.width,
        height: candidate.height,
        channels: 3,
        background: { r, g, b },
      },
    })
      .webp()
      .toBuffer();
    await upload(candidate.path, new Uint8Array(bytes), "image/webp");
  }
  await db`insert into public.assets (id, tenant_id, purpose) values (${asset}, ${SUR}, 'content')`;
  await db`
    insert into public.asset_versions (id, tenant_id, asset_id, version, status, declared_mime, declared_bytes,
                                       mime, bytes, width, height, sha256, ready_at, published_at)
    values (${randomUUID()}, ${SUR}, ${asset}, 1, 'ready', 'image/jpeg', 1000, 'image/jpeg', 1000, ${width},
            ${height}, ${"f".repeat(64)}, now(), now())`;
  return { assetId: asset };
}

/**
 * A published model as production leaves it: a synthetic GLB through the real processor and
 * optimizer (Meshopt geometry, KTX2 textures), with a flat poster of its own color, so the
 * screen tells the poster from the model drawn in 3D.
 */
const POSTER_COLOR: Rgb = [120, 90, 60];
const glb = { path: "", bytes: 0 };

async function publishModel(): Promise<string> {
  const asset = randomUUID();
  const version = randomUUID();
  const prefix = `${SUR}/${asset}/1/model/`;
  const original = await syntheticModel({ dataAsColor: false });
  const { optimized, manifest } = await optimizeAsProduction(original);
  const [r, g, b] = POSTER_COLOR;
  const poster = await sharp({
    create: { width: 1280, height: 960, channels: 3, background: { r, g, b } },
  })
    .webp()
    .toBuffer();
  await upload(`${prefix}poster.webp`, new Uint8Array(poster), "image/webp");
  await upload(`${prefix}model.glb`, optimized, "model/gltf-binary");
  glb.path = `${prefix}model.glb`;
  glb.bytes = optimized.byteLength;
  const published = {
    ...manifest,
    poster: { file: "poster.webp", width: 1280, height: 960, bytes: poster.byteLength },
  };
  await db`insert into public.assets (id, tenant_id, purpose) values (${asset}, ${SUR}, 'model')`;
  await db`
    insert into public.asset_versions (id, tenant_id, asset_id, version, status, declared_mime, declared_bytes,
                                       mime, bytes, sha256, ready_at, published_at, manifest)
    values (${version}, ${SUR}, ${asset}, 1, 'ready', 'model/gltf-binary', ${original.byteLength},
            'model/gltf-binary', ${original.byteLength}, ${"a".repeat(64)}, now(), now(),
            ${db.json(published as never)})`;
  return version;
}

/** The panel's RPCs, run as Demo Sur's owner (RLS, roles and checks are the real ones). */
async function asOwner<T>(work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return (await db.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: OWNER_SUR, role: "authenticated" })}, true)`;
    await tx`set local role authenticated`;
    return work(tx);
  })) as T;
}

async function publishedDestination(
  slug: string,
  title: string,
  location: { readonly lat: number; readonly lng: number },
): Promise<string> {
  return asOwner(async (tx) => {
    const [created] =
      await tx`select * from public.create_content_item(${SUR}, 'destination', ${slug}, ${title})`;
    const document = {
      title,
      summary: `${title} en 360°`,
      body: [],
      location,
      cover: null,
      gallery: [],
    };
    const [saved] =
      await tx`select * from public.save_content_draft(${SUR}, ${created?.content_id}, ${tx.json(document)}, ${created?.edit_count})`;
    await tx`select * from public.publish_content(${SUR}, ${created?.content_id}, ${saved?.edit_count})`;
    return created?.content_id as string;
  });
}

async function buildTours(photos: { assetId: string }[], model: string) {
  ids.slug = `museo-e2e-${RUN}`;
  ids.otherSlug = `plaza-e2e-${RUN}`;
  ids.destination = await publishedDestination(ids.slug, "Museo de prueba", MUSEUM_AT);
  ids.other = await publishedDestination(ids.otherSlug, "Plaza de prueba", PLAZA_AT);
  const { a, b, c, d } = SCENES as Required<Record<"a" | "b" | "c" | "d", Scene>>;

  // The second tour (one scene), the target of "go to another tour".
  await asOwner(async (tx) => {
    const [tour] = await tx`select * from public.create_tour(${SUR}, ${ids.other})`;
    const [scene] =
      await tx`select * from public.add_tour_scene(${SUR}, ${tour?.tour_id}, ${tour?.edit_count}, ${need(d.versionId)}, ${d.title})`;
    await tx`select * from public.publish_tour(${SUR}, ${tour?.tour_id}, ${scene?.edit_count})`;
    ids.otherTour = tour?.tour_id;
    d.sceneId = scene?.scene_id;
  });

  await asOwner(async (tx) => {
    const [tour] = await tx`select * from public.create_tour(${SUR}, ${ids.destination})`;
    let edit = tour?.edit_count as number;
    const tourId = tour?.tour_id as string;
    for (const scene of [a, b, c]) {
      const [added] =
        await tx`select * from public.add_tour_scene(${SUR}, ${tourId}, ${edit}, ${need(scene.versionId)}, ${scene.title})`;
      edit = added?.edit_count;
      scene.sceneId = added?.scene_id;
    }
    const hotspot = async (
      key: string,
      sceneId: string | undefined,
      body: Record<string, unknown>,
    ) => {
      const [added] =
        await tx`select * from public.add_tour_hotspot(${SUR}, ${tourId}, ${edit}, ${need(sceneId)}, ${tx.json(body as never)})`;
      edit = added?.edit_count;
      points[key] = added?.hotspot_id;
    };
    const at = (yaw: number, pitch = 0) => ({ yaw, pitch });
    await hotspot("info", a.sceneId, {
      kind: "info",
      title: "Arados antiguos",
      position: at(-0.45, -0.05),
      body: [{ type: "paragraph", children: [{ type: "text", text: "Usados hasta 1953." }] }],
      gallery: photos.map((photo, index) => ({
        assetId: photo.assetId,
        version: 1,
        alt: `Foto ${index + 1} del arado`,
      })),
    });
    await hotspot("toB", a.sceneId, {
      kind: "scene",
      title: "A la sala",
      position: at(0.25),
      targetSceneId: b.sceneId,
    });
    await hotspot("model", a.sceneId, {
      kind: "model",
      title: "Horno de barro",
      position: at(0, -0.4),
      modelVersionId: model,
      body: [
        {
          type: "paragraph",
          children: [
            { type: "text", text: "Horno de adobe con boca de arco, de un metro de alto." },
          ],
        },
      ],
    });
    await hotspot("jump", a.sceneId, {
      kind: "tour",
      title: "Ir a la plaza",
      position: at(0.6, -0.15),
      targetContentId: ids.other,
    });
    await hotspot("toC", b.sceneId, {
      kind: "scene",
      title: "Al taller",
      position: at(0.2),
      targetSceneId: c.sceneId,
    });
    await hotspot("backA", b.sceneId, {
      kind: "scene",
      title: "Al patio",
      position: at(-0.3),
      targetSceneId: a.sceneId,
    });
    await hotspot("cToB", c.sceneId, {
      kind: "scene",
      title: "A la sala",
      position: at(0),
      targetSceneId: b.sceneId,
    });
    await tx`select * from public.publish_tour(${SUR}, ${tourId}, ${edit})`;
    ids.tour = tourId;
  });

  // The carnival: four scenes in a row, arrows forward and back, text and photos at the entry.
  carnival.slug = `carnaval-e2e-${RUN}`;
  const carnivalId = await publishedDestination(carnival.slug, carnival.title, CARNIVAL_AT);
  await asOwner(async (tx) => {
    const [tour] = await tx`select * from public.create_tour(${SUR}, ${carnivalId})`;
    let edit = tour?.edit_count as number;
    const tourId = tour?.tour_id as string;
    const titles = [
      "Entrada de las comparsas",
      "Plaza de los trajes",
      "Calle de la música",
      "Final del desfile",
    ];
    for (const [index, scene] of [d, a, c, b].entries()) {
      const [added] =
        await tx`select * from public.add_tour_scene(${SUR}, ${tourId}, ${edit}, ${need(scene.versionId)}, ${titles[index] ?? ""})`;
      edit = added?.edit_count;
      carnival.scenes.push({
        key: scene.key,
        title: titles[index] ?? "",
        sceneId: added?.scene_id,
      });
    }
    const point = async (sceneId: string, body: Record<string, unknown>) => {
      const [added] =
        await tx`select * from public.add_tour_hotspot(${SUR}, ${tourId}, ${edit}, ${sceneId}, ${tx.json(body as never)})`;
      edit = added?.edit_count;
    };
    const first = carnival.scenes[0]?.sceneId ?? "";
    await point(first, {
      kind: "info",
      title: carnival.info,
      position: { yaw: -0.45, pitch: -0.05 },
      body: [
        { type: "paragraph", children: [{ type: "text", text: "Más de cuarenta comparsas." }] },
      ],
      gallery: photos.map((photo, index) => ({
        assetId: photo.assetId,
        version: 1,
        alt: `Traje ${index + 1}`,
      })),
    });
    for (const [index, scene] of carnival.scenes.entries()) {
      const next = carnival.scenes[index + 1];
      const previous = carnival.scenes[index - 1];
      if (next)
        await point(scene.sceneId, {
          kind: "scene",
          title: `Hacia ${next.title}`,
          position: { yaw: 0.25, pitch: 0 },
          targetSceneId: next.sceneId,
        });
      if (previous)
        await point(scene.sceneId, {
          kind: "scene",
          title: `Volver a ${previous.title}`,
          position: { yaw: -0.3, pitch: 0 },
          targetSceneId: previous.sceneId,
        });
    }
    await tx`select * from public.publish_tour(${SUR}, ${tourId}, ${edit})`;
    carnival.tourId = tourId;
  });

  // The general tour (P4 · Paso 5): the plaza first, and it starts there.
  await asOwner(async (tx) => {
    const [settings] =
      await tx`select coalesce((select edit_count from public.general_tours where tenant_id = ${SUR}), 0) as edit`;
    await tx`select * from public.save_general_tour(${SUR}, ${settings?.edit}, ${[ids.otherTour, ids.tour]}::uuid[], ${ids.otherTour})`;
  });
}

let browser: Browser;
let noWebgl: Browser;

/** Average color of the middle of the viewer (the panorama, not its points). */
async function viewerColor(page: Page): Promise<Rgb> {
  const viewport = page.locator(".tour-viewport");
  await viewport.scrollIntoViewIfNeeded();
  const box = await viewport.boundingBox();
  if (!box) throw new Error("no viewer");
  // A patch left of the centre, below the horizon: panorama only, never a point or the navbar.
  const shot = await sharp(await viewport.screenshot())
    .extract({
      left: Math.round(box.width * 0.1),
      top: Math.round(box.height * 0.55),
      width: 60,
      height: 40,
    })
    .toBuffer();
  const { data } = await sharp(shot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const sum = [0, 0, 0];
  for (let i = 0; i < data.length; i += 3)
    for (let c = 0; c < 3; c += 1) sum[c] = (sum[c] ?? 0) + (data[i + c] ?? 0);
  const n = data.length / 3;
  return [(sum[0] ?? 0) / n, (sum[1] ?? 0) / n, (sum[2] ?? 0) / n];
}

/** Which scene's color is on screen (the nearest one). */
async function sceneOnScreen(page: Page): Promise<string> {
  const color = await viewerColor(page);
  const distance = (scene: Scene) =>
    Math.hypot(color[0] - scene.color[0], color[1] - scene.color[1], color[2] - scene.color[2]);
  return Object.values(SCENES).sort((x, y) => distance(x) - distance(y))[0]?.key ?? "";
}

async function settledOn(page: Page, sceneId: string) {
  await settled(page, { sceneId } as Scene);
}

async function settled(page: Page, scene: Scene) {
  await page.waitForFunction(
    (id) => {
      const stage = document.querySelector<HTMLElement>(".tour-stage");
      return stage !== null && stage.dataset.currentScene === id && stage.dataset.shownScene === id;
    },
    scene.sceneId,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(1200); // tiles and the fade
}

/** Still the same document and the same Photo Sphere Viewer as when the walk started. */
async function sameViewer(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const marks = window as unknown as Record<string, unknown>;
    return (
      marks.rikuySamePage === true && marks.rikuyViewer === document.querySelector(".psv-container")
    );
  });
}

async function marker(page: Page, key: string) {
  await page.locator(".tour-stage").scrollIntoViewIfNeeded();
  const point = page.locator(`.psv-marker .hotspot-marker[data-hotspot="${points[key]}"]`);
  await point.waitFor({ timeout: 20_000 });
  await page.waitForTimeout(300);
  return point;
}

/** Whether a frame is something else than a flat poster color (the model is drawn). */
async function differsFrom(png: Buffer, color: Rgb): Promise<boolean> {
  const { data } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let far = 0;
  for (let i = 0; i < data.length; i += 3) {
    const d = Math.hypot(
      (data[i] ?? 0) - color[0],
      (data[i + 1] ?? 0) - color[1],
      (data[i + 2] ?? 0) - color[2],
    );
    if (d > 60) far += 1;
  }
  return far / (data.length / 3) > 0.05;
}

/**
 * Two frames of the same view (a few pixels may differ from antialiasing). The edge is left
 * out: the keyboard brings the focus ring in.
 */
async function sameImage(a: Buffer, b: Buffer): Promise<boolean> {
  const [x, y] = await Promise.all(
    [a, b].map(async (png) => {
      const { width = 0, height = 0 } = await sharp(png).metadata();
      return sharp(png)
        .extract({ left: 8, top: 8, width: width - 16, height: height - 16 })
        .removeAlpha()
        .raw()
        .toBuffer();
    }),
  );
  if (!x || !y || x.length !== y.length) return false;
  let different = 0;
  for (let i = 0; i < x.length; i += 3) {
    if (Math.abs((x[i] ?? 0) - (y[i] ?? 0)) + Math.abs((x[i + 1] ?? 0) - (y[i + 1] ?? 0)) > 24)
      different += 1;
  }
  return different / (x.length / 3) < 0.005;
}

// ── The panel (RC-01): sign-in with the code from Mailpit, as in CI, or a fixed local one ──
const ADMIN = `http://app.localhost:${PORT}`;

async function emailCode(email: string, since: number): Promise<string> {
  if (process.env.E2E_EMAIL_CODE) return process.env.E2E_EMAIL_CODE;
  const mailpit = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const search = (await (
      await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)
    ).json()) as { messages?: { ID: string; Created: string }[] };
    const id = search.messages?.find((m) => Date.parse(m.Created) >= since - 1000)?.ID;
    if (id) {
      const message = (await (await fetch(`${mailpit}/api/v1/message/${id}`)).json()) as {
        Text?: string;
        HTML?: string;
      };
      const code = /\b(\d{6})\b/u.exec(`${message.Text ?? ""} ${message.HTML ?? ""}`)?.[1];
      if (code) return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no sign-in email for ${email}`);
}

async function signIn(page: Page, email: string) {
  await page.goto(`${ADMIN}/login`);
  await page.getByLabel("Correo electrónico").fill(email);
  const since = Date.now();
  await page.getByRole("button", { name: "Recibir código" }).click();
  await page.getByLabel("Código de acceso").waitFor();
  await page.getByLabel("Código de acceso").fill(await emailCode(email, since));
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });
}

/** A point of a revision, with everything an edit must keep (RC-01). */
async function pointRow(revision: "draft" | "published", hotspotId: string) {
  const column = revision === "draft" ? "draft_revision_id" : "published_revision_id";
  const [row] = await db`
    select h.scene_id, h.kind::text as kind, h.title, h.yaw, h.pitch, h.body,
           h.target_scene_id, h.model_version_id, h.target_content_id,
           coalesce((select jsonb_agg(jsonb_build_object('version', i.asset_version_id, 'alt', i.alt_text) order by i.position)
                     from public.tour_hotspot_images i
                     where i.tour_revision_id = h.tour_revision_id and i.hotspot_id = h.hotspot_id), '[]') as gallery
    from public.tour_hotspots h
    join public.tours t on t.${db(column)} = h.tour_revision_id
    where t.id = ${ids.tour} and h.hotspot_id = ${hotspotId}`;
  return row;
}

const ready = SUPABASE_URL !== "" && SECRET !== "";

describe.runIf(ready)("RC-07 · a tour in the portal", () => {
  beforeAll(async () => {
    for (const scene of Object.values(SCENES)) await publishPanorama(scene);
    const photos = [await publishPhoto([200, 160, 90]), await publishPhoto([90, 120, 160])];
    await buildTours(photos, await publishModel());
    const args = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
    browser = await chromium.launch({ executablePath: CHROME, args });
    noWebgl = await chromium.launch({
      executablePath: CHROME,
      args: ["--disable-webgl", "--disable-webgl2", "--disable-3d-apis"],
    });
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    await noWebgl?.close();
    await db.end({ timeout: 5 });
  });

  it("walks the whole tour: entry, information, gallery, arrow, next, previous, model, another tour, back", async () => {
    const { a, b, c, d } = SCENES as Required<Record<"a" | "b" | "c" | "d", Scene>>;
    const page = await (
      await browser.newContext({ viewport: { width: 1280, height: 900 } })
    ).newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));

    await page.goto(`${PORTAL}/destinos/${ids.slug}`);
    const link = page.getByRole("link", { name: "Ver el tour 360°" });
    expect(await link.getAttribute("href")).toBe(`/destinos/${ids.slug}/tour`);
    // Performance budget: no panorama file before the visitor opens the tour.
    expect(requests.filter((url) => url.includes("/panorama/"))).toEqual([]);

    await link.click();
    await settled(page, a);
    // From here on: the same page and the same viewer (WebGL is never rebuilt).
    await page.evaluate(() => {
      const marks = window as unknown as Record<string, unknown>;
      marks.rikuySamePage = true;
      marks.rikuyViewer = document.querySelector(".psv-container");
    });
    expect(await page.locator(".tour-bar-title").textContent()).toContain("Escena 1 de 3");
    expect(await sceneOnScreen(page)).toBe("a");
    // Only the entry was downloaded (and the previews its arrows lead to).
    expect(requests.some((url) => url.includes(`${b.assetId}/1/panorama/tiles`))).toBe(false);

    // Information with its gallery, from the point on the panorama.
    await (await marker(page, "info")).click();
    const dialog = page.locator("dialog.tour-dialog[open]");
    await dialog.waitFor();
    expect(await dialog.locator("h2").textContent()).toBe("Arados antiguos");
    expect(await dialog.textContent()).toContain("Usados hasta 1953.");
    expect(await dialog.getByText("Foto 1 de 2").count()).toBe(1);
    await dialog.getByRole("button", { name: "Siguiente" }).click();
    expect(await dialog.getByText("Foto 2 de 2").count()).toBe(1);
    expect(await dialog.locator("img").getAttribute("alt")).toBe("Foto 2 del arado");
    await dialog.getByRole("button", { name: "Anterior" }).click();
    expect(await dialog.getByText("Foto 1 de 2").count()).toBe(1);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });

    // The arrow: a large panorama, served as tiles.
    await (await marker(page, "toB")).click();
    await settled(page, b);
    expect(await sceneOnScreen(page)).toBe("b");
    expect(requests.some((url) => url.includes(`${b.assetId}/1/panorama/tiles/`))).toBe(true);
    expect(requests.some((url) => url.includes(`${b.assetId}/1/panorama/image.webp`))).toBe(false);
    expect(new URL(page.url()).searchParams.get("escena")).toBe(b.sceneId);
    expect(await sameViewer(page)).toBe(true);

    // Next and previous, in the published order.
    await page.getByRole("button", { name: /^Siguiente/ }).click();
    await settled(page, c);
    expect(await sceneOnScreen(page)).toBe("c");
    expect(await page.getByRole("button", { name: /^Siguiente/ }).isDisabled()).toBe(true);
    await page.getByRole("button", { name: /^Anterior/ }).click();
    await settled(page, b);
    await page.getByRole("button", { name: /^Anterior/ }).click();
    await settled(page, a);
    expect(await sceneOnScreen(page)).toBe("a");

    // The model's poster.
    await (await marker(page, "model")).click();
    await dialog.waitFor();
    expect(await dialog.locator("h2").textContent()).toBe("Horno de barro");
    expect(await dialog.locator("img").getAttribute("alt")).toBe(
      "Imagen del modelo 3D «Horno de barro»",
    );
    expect(await dialog.textContent()).toContain("Horno de adobe con boca de arco");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });

    // "Go to another tour" opens that tour.
    const pill = await marker(page, "jump");
    expect(await pill.textContent()).toContain("Plaza de prueba");
    const beforeJump = requests.length;
    await pill.click();
    await page.waitForURL(`${PORTAL}/destinos/${ids.otherSlug}/tour`);
    await settled(page, d);
    expect(await sceneOnScreen(page)).toBe("d");
    // Without leaving the viewer: one request for that tour's data, no new page.
    expect(await sameViewer(page)).toBe(true);
    expect(
      requests.slice(beforeJump).filter((url) => url.includes("/recorrido/datos")),
    ).toHaveLength(1);
    expect(await page.locator("h1").textContent()).toBe("Plaza de prueba");
    expect(await page.title()).toContain("Tour 360° de Plaza de prueba");

    // And back to the destination.
    await page.getByRole("link", { name: "← Volver a Plaza de prueba" }).click();
    await page.waitForURL(`${PORTAL}/destinos/${ids.otherSlug}`);
    expect(errors).toEqual([]);
  });

  it("RC-07: walks each reference tour, scene by scene: entry, information, gallery, next to the end, previous back, out", async () => {
    const { a, b, c } = SCENES as Required<Record<"a" | "b" | "c", Scene>>;
    const museum: ReferenceTour = {
      slug: ids.slug,
      title: "Museo de prueba",
      tourId: ids.tour,
      scenes: [a, b, c].map((scene) => ({
        key: scene.key,
        title: scene.title,
        sceneId: need(scene.sceneId),
      })),
      info: "Arados antiguos",
    };
    for (const reference of [museum, carnival]) {
      const page = await (
        await browser.newContext({ viewport: { width: 1280, height: 900 } })
      ).newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(`${PORTAL}/destinos/${reference.slug}/tour`);
      const [entry] = reference.scenes;
      await settledOn(page, need(entry?.sceneId));
      const total = reference.scenes.length;

      // Information and its gallery, from the list (the same control as the point).
      await page.locator(".tour-points").getByRole("button", { name: reference.info }).click();
      const dialog = page.locator("dialog.tour-dialog[open]");
      await dialog.waitFor();
      expect(await dialog.getByText("Foto 1 de 2").count()).toBe(1);
      await dialog.getByRole("button", { name: "Siguiente" }).click();
      expect(await dialog.getByText("Foto 2 de 2").count()).toBe(1);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });

      // Next to the last scene, then previous back to the entry: each one on screen.
      const next = page.getByRole("button", { name: /^Siguiente/u });
      const previous = page.getByRole("button", { name: /^Anterior/u });
      const visit = async (index: number) => {
        const scene = reference.scenes[index];
        await settledOn(page, need(scene?.sceneId));
        expect(await sceneOnScreen(page), `${reference.title} · ${scene?.title}`).toBe(scene?.key);
        expect(await page.locator(".tour-bar-title").textContent()).toContain(
          `Escena ${index + 1} de ${total}`,
        );
        expect(await page.locator("#tour-escena").textContent()).toBe(scene?.title);
      };
      expect(await previous.isDisabled()).toBe(true);
      for (let index = 1; index < total; index += 1) {
        await next.click();
        await visit(index);
      }
      expect(await next.isDisabled()).toBe(true);
      for (let index = total - 2; index >= 0; index -= 1) {
        await previous.click();
        await visit(index);
      }

      // Out: back to the destination.
      await page.getByRole("link", { name: `← Volver a ${reference.title}` }).click();
      await page.waitForURL(`${PORTAL}/destinos/${reference.slug}`);
      expect(errors).toEqual([]);
      await page.context().close();
    }
  });

  it("measures a visit with ?medir, on the device only, and never shows up without it", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`${PORTAL}/destinos/${ids.slug}/tour`);
    await settled(page, SCENES.a as Scene);
    expect(await page.locator(".measure-panel").count()).toBe(0);

    const requests: string[] = [];
    page.on("request", (request) => requests.push(`${request.method()} ${request.url()}`));
    await page.goto(`${PORTAL}/destinos/${ids.slug}/tour?medir=1`);
    const panel = page.getByRole("complementary", { name: "Medición del tour" });
    await panel.waitFor();
    const report = panel.locator(".measure-panel-report");
    await report.filter({ hasText: "Primera escena en pantalla: " }).waitFor({ timeout: 30_000 });
    await panel.getByRole("button", { name: "1. Medir 20 cambios de escena" }).click();
    await report.filter({ hasText: "Cambios: 20" }).waitFor({ timeout: 240_000 });
    const text = (await report.textContent()) ?? "";
    expect(text).toContain("Sin terminar en 30 s: 0");
    expect(text).toMatch(/Primera escena en pantalla: \d+ ms/u);
    expect(text).toMatch(/Hasta ver la escena \(p95\): \d+ ms/u);
    // Nothing leaves the device: only GETs to the portal and to Storage.
    expect(requests.filter((line) => !line.startsWith("GET "))).toEqual([]);
    expect(
      new Set(requests.map((line) => new URL(line.slice(line.indexOf(" ") + 1)).origin)),
    ).toEqual(new Set([new URL(PORTAL).origin, new URL(SUPABASE_URL).origin]));
    expect(errors).toEqual([]);
    await context.close();
  }, 300_000);

  it("RC-08: the model loads only when asked for, closes, reopens, retries and frees its memory", async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    const glbRequests = () => requests.filter((url) => url.includes(glb.path)).length;

    await page.goto(`${PORTAL}/destinos/${ids.slug}/tour`);
    await settled(page, SCENES.a as Scene);
    // The poster, its description and the size, and still nothing of the model.
    await (await marker(page, "model")).click();
    const dialog = page.locator("dialog.tour-dialog[open]");
    await dialog.waitFor();
    await dialog.locator(".tour-model-poster img").waitFor();
    expect(await dialog.textContent()).toContain("Horno de adobe con boca de arco");
    const open3d = dialog.getByRole("button", { name: "Ver en 3D" });
    expect(await dialog.locator(".tour-model-hint").textContent()).toMatch(
      /^Descarga de \d+,\d MB\./u,
    );
    await page.waitForTimeout(500);
    expect(glbRequests()).toBe(0);
    expect(requests.some((url) => url.includes("/vendor/three/"))).toBe(false);

    // Open: one download, the model drawn in place of the poster, the focus on it.
    const stage = dialog.locator(".tour-model-stage");
    const status = dialog.locator(".tour-model-status");
    await open3d.click();
    await status.filter({ hasText: "Modelo 3D listo." }).waitFor({ timeout: 60_000 });
    expect(glbRequests()).toBe(1);
    expect(await dialog.locator(".tour-model-poster").isHidden()).toBe(true);
    const canvas = stage.locator("canvas");
    expect(await canvas.getAttribute("aria-label")).toContain("Modelo 3D «Horno de barro»");
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("CANVAS");
    await page.waitForTimeout(300);
    const first = await stage.screenshot();
    expect(await differsFrom(first, POSTER_COLOR)).toBe(true);
    // Nothing moves by itself ("reduce motion" needs nothing more).
    await page.waitForTimeout(800);
    expect(await sameImage(first, await stage.screenshot())).toBe(true);
    // The keyboard turns it; Home goes back to the first view.
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(200);
    expect(await sameImage(first, await stage.screenshot())).toBe(false);
    await page.keyboard.press("Home");
    await page.waitForTimeout(200);
    expect(await sameImage(first, await stage.screenshot())).toBe(true);

    // Back to the poster: the WebGL context is given back at once.
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).rikuyModelCanvas = document.querySelector(
        ".tour-model-stage canvas",
      );
    });
    await dialog.getByRole("button", { name: "Volver a la imagen" }).click();
    expect(await canvas.count()).toBe(0);
    expect(await dialog.locator(".tour-model-poster").isVisible()).toBe(true);
    expect(
      await page.evaluate(() => {
        const old = (window as unknown as Record<string, HTMLCanvasElement>).rikuyModelCanvas;
        return old?.getContext("webgl2")?.isContextLost() ?? null;
      }),
    ).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Ver en 3D");

    // Reopen, then close the dialog and open the point again: it starts from the poster.
    await open3d.click();
    await status.filter({ hasText: "Modelo 3D listo." }).waitFor({ timeout: 60_000 });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await (await marker(page, "model")).click();
    await dialog.waitFor();
    expect(await dialog.locator(".tour-model-stage canvas").count()).toBe(0);
    expect(await dialog.locator(".tour-model-poster").isVisible()).toBe(true);

    // A download that fails: the poster stays, with "Reintentar"; the retry works.
    await page.route(`**/${glb.path}`, (route) => route.abort("connectionreset"));
    await dialog.getByRole("button", { name: "Ver en 3D" }).click();
    await status
      .filter({ hasText: "No se pudo descargar el modelo 3D" })
      .waitFor({ timeout: 30_000 });
    expect(await dialog.locator(".tour-model-poster").isVisible()).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Reintentar");
    await page.unroute(`**/${glb.path}`);
    await dialog.getByRole("button", { name: "Reintentar" }).click();
    await status.filter({ hasText: "Modelo 3D listo." }).waitFor({ timeout: 60_000 });

    // The GPU drops the context (a phone short of video memory): back to the poster, with
    // a notice and a way to open it again.
    await page.evaluate(() => {
      const element = document.querySelector<HTMLCanvasElement>(".tour-model-stage canvas");
      element?.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
    });
    await status.filter({ hasText: "El visor 3D se cerró" }).waitFor({ timeout: 10_000 });
    expect(await dialog.locator(".tour-model-poster").isVisible()).toBe(true);
    expect(await dialog.locator(".tour-model-stage canvas").count()).toBe(0);
    await dialog.getByRole("button", { name: "Volver a abrir en 3D" }).click();
    await status.filter({ hasText: "Modelo 3D listo." }).waitFor({ timeout: 60_000 });

    // Only our own origin and Storage: the Basis transcoder too, never a CDN.
    const origins = new Set(requests.map((url) => new URL(url).origin));
    expect([...origins].sort()).toEqual(
      [new URL(PORTAL).origin, new URL(SUPABASE_URL).origin].sort(),
    );
    expect(requests.some((url) => url.includes("/vendor/three/") && url.includes("basis"))).toBe(
      true,
    );
    expect(errors).toEqual([]);
  });

  it("ends on the last scene asked for, even when an older one answers late", async () => {
    const { a, b, c } = SCENES as Required<Record<"a" | "b" | "c", Scene>>;
    const page = await (
      await browser.newContext({ viewport: { width: 1280, height: 900 } })
    ).newPage();
    await page.goto(`${PORTAL}/destinos/${ids.slug}/tour?escena=${b.sceneId}`);
    // A shared link opens its scene.
    await settled(page, b);
    expect(await sceneOnScreen(page)).toBe("b");

    // The workshop answers late; the visitor asks for it and, at once, for the patio.
    let delayed = 0;
    await page.route(`**/${c.assetId}/1/panorama/**`, async (route) => {
      delayed += 1;
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await route.continue();
    });
    const list = page.getByRole("navigation", { name: "Escenas del tour" });
    await list.getByRole("button", { name: c.title }).click();
    await list.getByRole("button", { name: a.title }).click();
    await settled(page, a);
    await page.waitForTimeout(3500); // the workshop's files arrive now
    expect(delayed).toBeGreaterThan(0);
    expect(await page.locator(".tour-stage").getAttribute("data-shown-scene")).toBe(a.sceneId);
    expect(await sceneOnScreen(page)).toBe("a");
    expect(await page.locator("#tour-escena").textContent()).toBe(a.title);
    // The entry needs no parameter: the address is the tour's own again.
    expect(new URL(page.url()).searchParams.get("escena")).toBeNull();

    // Several taps in a row: the last one wins.
    for (const scene of [b, c, b, c]) await list.getByRole("button", { name: scene.title }).click();
    await settled(page, c);
    await page.waitForTimeout(3000);
    expect(await sceneOnScreen(page)).toBe("c");
    expect(await page.locator(".tour-stage").getAttribute("data-shown-scene")).toBe(c.sceneId);
  });

  it("is one general tour: the municipality's order and start, jumps without leaving the viewer, back, «cerca de ti»", async () => {
    const { a, b, c, d } = SCENES as Required<Record<"a" | "b" | "c" | "d", Scene>>;
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      geolocation: { latitude: MUSEUM_AT.lat + 0.0005, longitude: MUSEUM_AT.lng },
      permissions: ["geolocation"],
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));

    // The header links the general tour; it starts where the municipality chose. (A page
    // first rendered after the fixture: the home page may still be the cached one from
    // before, without tours, until it revalidates.)
    await page.goto(`${PORTAL}/destinos/${ids.otherSlug}`);
    const header = page.getByRole("navigation", { name: "Principal" });
    expect(await header.getByRole("link", { name: "Tours 360°" }).getAttribute("href")).toBe(
      "/recorrido",
    );
    await header.getByRole("link", { name: "Tours 360°" }).click();
    await page.waitForURL(`${PORTAL}/recorrido`);
    await settled(page, d);
    expect(await page.locator("h1").textContent()).toBe("Plaza de prueba");
    await page.evaluate(() => {
      const marks = window as unknown as Record<string, unknown>;
      marks.rikuySamePage = true;
      marks.rikuyViewer = document.querySelector(".psv-container");
    });
    // Only the chosen tour: nothing of the museum yet, not even its preview in the menu.
    expect(requests.some((url) => url.includes(`${a.assetId}/`))).toBe(false);

    // The menu: the municipality's order, the current tour marked.
    const toggle = page.getByRole("button", { name: /Tours del municipio/ });
    await toggle.click();
    const menu = page.locator("#tour-menu");
    await menu.waitFor();
    const titles = () => menu.locator(".tour-menu-entry strong").allTextContents();
    // (A local stack may keep tours of earlier runs: they come after, without a place.)
    expect((await titles()).slice(0, 2)).toEqual(["Plaza de prueba", "Museo de prueba"]);
    expect(await menu.locator('[aria-current="page"]').textContent()).toContain("Plaza de prueba");

    // «Cerca de ti»: next to the museum, it comes first.
    await menu.getByRole("button", { name: "Ver los más cercanos" }).click();
    await menu.locator('[data-order="proximity"]').waitFor();
    expect((await titles())[0]).toBe("Museo de prueba");
    expect((await titles()).at(-1)).toBe("Plaza de prueba");

    // Jump: one request for the museum's data and its entry; nothing of its other scenes.
    const beforeJump = requests.length;
    await menu.getByRole("link", { name: /Museo de prueba/ }).click();
    await page.waitForURL(`${PORTAL}/destinos/${ids.slug}/tour`);
    await settled(page, a);
    expect(await sceneOnScreen(page)).toBe("a");
    expect(await sameViewer(page)).toBe(true);
    const jump = requests.slice(beforeJump);
    expect(jump.filter((url) => url.includes("/recorrido/datos"))).toHaveLength(1);
    expect(
      jump.some(
        (url) =>
          url.includes(`${b.assetId}/1/panorama/tiles`) ||
          url.includes(`${c.assetId}/1/panorama/image`),
      ),
    ).toBe(false);
    expect(await menu.isHidden()).toBe(true);

    // Back returns to the general tour, again without leaving the viewer.
    await page.goBack();
    await page.waitForURL(`${PORTAL}/recorrido`);
    await settled(page, d);
    expect(await page.locator("h1").textContent()).toBe("Plaza de prueba");
    expect(await sameViewer(page)).toBe(true);

    // A late answer never wins: on a fresh visit, the museum's data arrives late and the
    // visitor goes back to the plaza meanwhile.
    const fresh = await (
      await browser.newContext({ viewport: { width: 1280, height: 900 } })
    ).newPage();
    let late = 0;
    await fresh.route("**/recorrido/datos?*", async (route) => {
      late += 1;
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await route.continue().catch(() => undefined); // the browser may have cancelled it
    });
    await fresh.goto(`${PORTAL}/recorrido`);
    await settled(fresh, d);
    const freshToggle = fresh.getByRole("button", { name: /Tours del municipio/ });
    const freshMenu = fresh.locator("#tour-menu");
    await freshToggle.click();
    await freshMenu.getByRole("link", { name: /Museo de prueba/ }).click();
    expect(await fresh.locator(".tour-bar-title span").textContent()).toBe("Abriendo el tour…");
    await freshToggle.click();
    await freshMenu.getByRole("link", { name: /Plaza de prueba/ }).click();
    await fresh.waitForTimeout(3500);
    expect(late).toBe(1);
    expect(await fresh.locator(".tour-explorer").getAttribute("data-tour")).toBe(
      `destination:${ids.otherSlug}`,
    );
    expect(new URL(fresh.url()).pathname).toBe("/recorrido");
    expect(await sceneOnScreen(fresh)).toBe("d");
    expect(errors).toEqual([]);
  });

  it("works as text without WebGL, with the keyboard", async () => {
    const { a, c } = SCENES as Required<Record<"a" | "c", Scene>>;
    const page = await (
      await noWebgl.newContext({ viewport: { width: 390, height: 844 } })
    ).newPage();
    await page.goto(`${PORTAL}/destinos/${ids.slug}/tour`);
    await page
      .getByText("Este navegador no puede mostrar la vista 360°")
      .waitFor({ timeout: 30_000 });
    const flat = page.locator(".tour-flat img");
    expect(await flat.getAttribute("src")).toContain(`${a.assetId}/1/panorama/image.webp`);
    // Every point is a control in the list.
    const info = page.getByRole("button", { name: "Arados antiguos" });
    await info.focus();
    await page.keyboard.press("Enter");
    const dialog = page.locator("dialog.tour-dialog[open]");
    await dialog.waitFor();
    expect(await dialog.getByText("Foto 1 de 2").count()).toBe(1);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    // Focus goes back to the point that opened it.
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Arados antiguos");
    // The model: its poster and description are the model; "Ver en 3D" says why not.
    await page.getByRole("button", { name: "Horno de barro" }).click();
    await dialog.waitFor();
    expect(await dialog.textContent()).toContain("Horno de adobe con boca de arco");
    await dialog.getByRole("button", { name: "Ver en 3D" }).click();
    const notice = dialog.getByText("Este navegador no puede mostrar modelos 3D");
    await notice.waitFor({ timeout: 30_000 });
    expect(await dialog.getByRole("button", { name: "Ver en 3D" }).count()).toBe(0);
    expect(await page.evaluate(() => document.activeElement?.className)).toBe("tour-model-status");
    expect(await dialog.locator(".tour-model-poster").isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    // Scenes from the list.
    await page
      .getByRole("navigation", { name: "Escenas del tour" })
      .getByRole("button", { name: c.title })
      .click();
    expect(await page.locator("#tour-escena").textContent()).toBe(c.title);
    expect(await flat.getAttribute("src")).toContain(`${c.assetId}/1/panorama/image.webp`);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBe(0);
  });

  it("RC-01: the panel's point editor saves only what changed and never mixes two points", async () => {
    const { b } = SCENES as Required<Record<"b", Scene>>;
    const page = await (
      await browser.newContext({ viewport: { width: 1280, height: 900 } })
    ).newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await signIn(page, "owner@demo-sur.example.test");
    const editor = `${ADMIN}/o/demo-sur/tours/${ids.tour}`;
    await page.goto(editor);
    const form = page.locator("form.hotspot-form");
    const status = (text: string) =>
      page.getByRole("status").filter({ hasText: text }).waitFor({ timeout: 20_000 });

    // The model point: its options and its own values come in the same server response.
    const before = await pointRow("published", need(points.model));
    await page.getByRole("button", { name: "Editar «Horno de barro»" }).click();
    const chosenModel = form.locator(".hotspot-model input:checked");
    expect(await chosenModel.getAttribute("value")).toBe(before?.model_version_id);
    expect(await form.getByLabel("Descripción del modelo").inputValue()).toContain(
      "Horno de adobe",
    );
    // Only the name: saved, then the page reloaded.
    await form.getByLabel("Nombre del punto").fill("Horno de barro del patio");
    await form.getByRole("button", { name: "Guardar el punto" }).click();
    await status("Se guardó «Horno de barro»");
    await page.reload();
    await page.getByRole("button", { name: "Editar «Horno de barro del patio»" }).click();
    expect(await form.locator(".hotspot-model input:checked").getAttribute("value")).toBe(
      before?.model_version_id,
    );
    expect(await form.getByLabel("Descripción del modelo").inputValue()).toContain(
      "Horno de adobe",
    );
    await form.getByRole("button", { name: "Cancelar" }).click();
    // Scene, kind, model, description and position, as they were; only the name changed.
    expect(await pointRow("draft", need(points.model))).toEqual({
      ...before,
      title: "Horno de barro del patio",
    });

    // The information point: a new name keeps its text and its photos, in their order.
    const info = await pointRow("published", need(points.info));
    await page.getByRole("button", { name: "Editar «Arados antiguos»" }).click();
    await form.getByLabel("Nombre del punto").fill("Arados y yugos");
    await form.getByRole("button", { name: "Guardar el punto" }).click();
    await status("Se guardó «Arados antiguos»");
    expect(await pointRow("draft", need(points.info))).toEqual({
      ...info,
      title: "Arados y yugos",
    });
    expect((info?.gallery as unknown[]).length).toBe(2);

    // A, then B: B's form shows B's own target; an unsaved change to A does not travel.
    await page.getByRole("button", { name: "Editar «Ir a la plaza»" }).click();
    const tourTarget = form.getByLabel("Lleva al tour de");
    expect(await tourTarget.inputValue()).toBe(ids.other);
    const others = await tourTarget
      .locator("option:not([disabled])")
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    await tourTarget.selectOption(others.find((value) => value !== ids.other) ?? "");
    expect(await tourTarget.inputValue()).not.toBe(ids.other);
    await page.getByRole("button", { name: "Editar «A la sala»" }).click();
    expect(await form.getByLabel("Lleva al tour de").count()).toBe(0);
    expect(await form.getByLabel("Lleva a la escena").inputValue()).toBe(b.sceneId);
    await page.getByRole("button", { name: "Editar «Ir a la plaza»" }).click();
    expect(await form.getByLabel("Lleva al tour de").inputValue()).toBe(ids.other);
    await page.getByRole("button", { name: "Editar «Horno de barro del patio»" }).click();
    expect(await form.locator(".hotspot-model input:checked").getAttribute("value")).toBe(
      before?.model_version_id,
    );
    await form.getByRole("button", { name: "Cancelar" }).click();
    // Nothing of that was saved.
    expect(await pointRow("draft", need(points.jump))).toEqual(
      await pointRow("published", need(points.jump)),
    );

    // The published tour never changed; the draft is discarded.
    expect((await pointRow("published", need(points.model)))?.title).toBe("Horno de barro");
    await page.getByRole("button", { name: "Descartar cambios" }).click();
    await page.getByRole("button", { name: "Confirmar: descartar los cambios" }).click();
    await status("Se descartaron los cambios");
    expect(errors).toEqual([]);
  });
});
