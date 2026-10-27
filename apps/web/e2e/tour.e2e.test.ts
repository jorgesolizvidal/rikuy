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
import { createSharpPanoramaRenderer } from "@rikuy/db/worker";
import { chromium, type Browser, type Page } from "playwright-core";
import postgres from "postgres";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

async function publishModel(): Promise<string> {
  const asset = randomUUID();
  const version = randomUUID();
  const prefix = `${SUR}/${asset}/1/model/`;
  const poster = await sharp({
    create: { width: 1280, height: 960, channels: 3, background: { r: 120, g: 90, b: 60 } },
  })
    .webp()
    .toBuffer();
  await upload(`${prefix}poster.webp`, new Uint8Array(poster), "image/webp");
  await upload(`${prefix}model.glb`, new Uint8Array(64), "model/gltf-binary");
  const manifest = {
    version: 1,
    format: "glb",
    source: {
      bytes: 482828,
      sha256: "a".repeat(64),
      triangles: 1200,
      vertices: 800,
      materials: 1,
      textures: 0,
      generator: "e2e",
      extensions: [],
    },
    model: { file: "model.glb", bytes: 64, triangles: 1200, geometry: "meshopt", textures: [] },
    colors: { materials: "unchanged", vertexColors: null, suspects: [] },
    weight: "light",
    poster: { file: "poster.webp", width: 1280, height: 960, bytes: poster.byteLength },
  };
  await db`insert into public.assets (id, tenant_id, purpose) values (${asset}, ${SUR}, 'model')`;
  await db`
    insert into public.asset_versions (id, tenant_id, asset_id, version, status, declared_mime, declared_bytes,
                                       mime, bytes, sha256, ready_at, published_at, manifest)
    values (${version}, ${SUR}, ${asset}, 1, 'ready', 'model/gltf-binary', 482828, 'model/gltf-binary', 482828,
            ${"a".repeat(64)}, now(), now(), ${db.json(manifest)})`;
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

    // The header links the general tour; it starts where the municipality chose.
    await page.goto(`${PORTAL}/`);
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
});
