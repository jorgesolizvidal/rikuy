/**
 * C0 · Paso 2 (ADR-048) in a real browser against the local stack, in Demo Sur:
 *
 * - «Panoramas 360°» tells which tour uses each panorama; the owner replaces the one the
 *   published tour uses (a real signed upload; the pipeline's result is set by the test),
 *   then «Usar la versión nueva en los tours» puts it in a new draft while visitors keep
 *   the old one;
 * - a panorama no tour used is deleted (after confirming) and its files go to the cleanup;
 * - «Modelos 3D»: a photo becomes the model's image (shrunk in the browser, re-encoded by
 *   the server);
 * - an analyst sees where they are used, without replacing or deleting;
 * - the pages are checked with axe and for overflow at 390 and 1280 px.
 */
import { randomUUID } from "node:crypto";

import axe from "axe-core";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import postgres from "postgres";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { passSecondFactor } from "./support/second-factor";

/**
 * Waits until React has hydrated a file input: before that, choosing a file fires a change
 * event nobody listens to, and the upload never starts (what made this test flaky in CI).
 */
async function hydrated(input: Locator): Promise<Locator> {
  await input.waitFor({ state: "attached" });
  await expect
    .poll(
      () =>
        input.evaluate((element) =>
          Object.keys(element).some((key) => key.startsWith("__reactProps")),
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
  return input;
}

const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = Number(process.env.RIKUY_PORT ?? 3000);
const ADMIN = `http://app.localhost:${PORT}`;
const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const SECRET = process.env.SUPABASE_SECRET_KEY ?? "";
const SUR = "5eed1000-0000-4000-8000-000000000002";
const OWNER_SUR = "5eed0000-0000-4000-8000-000000000002";
const OWNER_EMAIL = "owner@demo-sur.example.test";
const ANALYST_EMAIL = "editor.ambos@example.test";
const TITLE = `Museo de reemplazos ${randomUUID().slice(0, 6)}`;
const PANO = {
  version: 1,
  projection: "equirectangular",
  source: {
    width: 8192,
    height: 4096,
    bytes: 9_000_000,
    mime: "image/jpeg",
    sha256: "a".repeat(64),
  },
  preview: { file: "preview.webp", width: 1024, height: 512, bytes: 18_000 },
  image: { file: "image.webp", width: 4096, height: 2048, bytes: 1_400_000 },
  tiles: null,
};
const MODEL = {
  version: 1,
  format: "glb",
  source: {
    bytes: 482_828,
    sha256: "a".repeat(64),
    triangles: 15_177,
    vertices: 4_612,
    materials: 4,
    textures: 0,
    generator: "Blender",
    extensions: [],
  },
  model: {
    file: "model.glb",
    bytes: 1_250_000,
    triangles: 15_177,
    geometry: "meshopt",
    textures: [],
  },
  colors: { materials: "unchanged", vertexColors: null, suspects: [] },
  weight: "light",
  poster: { file: "poster.webp", width: 1280, height: 960, bytes: 90_000 },
};

const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
let browser: Browser;
const used = { asset: randomUUID(), version: randomUUID() };
const unused = { asset: randomUUID(), version: randomUUID() };
const model = { asset: randomUUID(), version: randomUUID() };
let tourId = "";

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

async function signedIn(email: string): Promise<Page> {
  const page = await (
    await browser.newContext({ viewport: { width: 1280, height: 900 } })
  ).newPage();
  await page.goto(`${ADMIN}/login`);
  await page.getByLabel("Correo electrónico").fill(email);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const since = Date.now();
  await page.getByRole("button", { name: "Recibir código" }).click();
  await page.getByLabel("Código de acceso").fill(await emailCode(email, since));
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });
  await passSecondFactor(page, ADMIN);
  return page;
}

async function accessible(page: Page, label: string) {
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(axe.source);
    const result = (await page.evaluate(() =>
      (window as unknown as { axe: { run: (context: Document) => Promise<unknown> } }).axe.run(
        document,
      ),
    )) as { violations: { id: string; impact: string | null }[] };
    const serious = result.violations
      .filter((violation) => violation.impact === "critical" || violation.impact === "serious")
      .map((violation) => violation.id);
    expect(serious, `${label} at ${width} px`).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      `${label} overflows at ${width} px`,
    ).toBe(false);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** A file in the private bucket, as the pipeline leaves it (the panel signs it). */
async function storeOriginalsFile(path: string, body: Uint8Array, type: string) {
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/media-originals/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      apikey: SECRET,
      "content-type": type,
      "x-upsert": "true",
    },
    body: new Blob([new Uint8Array(body)], { type }),
  });
  if (!response.ok) throw new Error(`storage ${response.status}`);
}

describe("replacing and deleting panoramas and models (ADR-048)", () => {
  beforeAll(async () => {
    for (const [entry, purpose, manifest] of [
      [used, "panorama", PANO],
      [unused, "panorama", PANO],
      [model, "model", MODEL],
    ] as const) {
      const isModel = purpose === "model";
      await db`insert into public.assets (id, tenant_id, purpose) values (${entry.asset}, ${SUR}, ${purpose})`;
      await db`
        insert into public.asset_versions (id, tenant_id, asset_id, version, status, declared_mime, declared_bytes,
                                           mime, bytes, width, height, sha256, ready_at, manifest, published_at)
        values (${entry.version}, ${SUR}, ${entry.asset}, 1, 'ready',
                ${isModel ? "model/gltf-binary" : "image/jpeg"}, 1000,
                ${isModel ? "model/gltf-binary" : "image/jpeg"}, 1000,
                ${isModel ? null : 8192}, ${isModel ? null : 4096},
                ${"b".repeat(64)}, now(), ${db.json(manifest)}, now())`;
    }
    const folder = `${SUR}/${model.asset}/1/model/`;
    await storeOriginalsFile(
      `${folder}model.glb`,
      new TextEncoder().encode("glTF"),
      "model/gltf-binary",
    );
    await storeOriginalsFile(
      `${folder}poster.webp`,
      new Uint8Array(
        await sharp({ create: { width: 64, height: 48, channels: 3, background: "#777" } })
          .webp()
          .toBuffer(),
      ),
      "image/webp",
    );

    // A destination with a published tour: one scene on `used`, a point with the model.
    tourId = await db.begin(async (sql) => {
      await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: OWNER_SUR, role: "authenticated", aal: "aal2" })}, true)`;
      await sql`set local role authenticated`;
      const [content] = await sql<{ content_id: string }[]>`
        select content_id from public.create_content_item(${SUR}, 'destination', ${`reemplazos-${randomUUID().slice(0, 6)}`}, ${TITLE})`;
      const [tour] = await sql<
        { tour_id: string }[]
      >`select tour_id from public.create_tour(${SUR}, ${content!.content_id})`;
      const [scene] = await sql<{ scene_id: string; edit_count: number }[]>`
        select scene_id, edit_count from public.add_tour_scene(${SUR}, ${tour!.tour_id}, 1, ${used.version}, 'Sala')`;
      await sql`select public.add_tour_hotspot(${SUR}, ${tour!.tour_id}, ${scene!.edit_count}, ${scene!.scene_id},
        ${sql.json({ kind: "model", title: "Horno", position: { yaw: 0, pitch: -0.3 }, modelVersionId: model.version })})`;
      await sql`select * from public.publish_tour(${SUR}, ${tour!.tour_id}, ${scene!.edit_count + 1})`;
      return tour!.tour_id;
    });

    browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
    });
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    await db.end({ timeout: 5 });
  });

  it("replaces a panorama a published tour uses, without changing what visitors see", async () => {
    const page = await signedIn(OWNER_EMAIL);
    await page.goto(`${ADMIN}/o/demo-sur/panoramas`);
    const card = page.locator(`li[data-asset="${used.asset}"]`);
    await expect(card.innerText()).resolves.toContain(`Tour de «${TITLE}»`);
    await expect(card.innerText()).resolves.toContain("No se puede borrar");

    await (
      await hydrated(card.locator("input[type=file]"))
    ).setInputFiles({
      name: "sala.jpg",
      mimeType: "image/jpeg",
      buffer: await sharp({
        create: { width: 2048, height: 1024, channels: 3, background: "#468" },
      })
        .jpeg()
        .toBuffer(),
    });
    await card
      .getByText("Versión nueva subida")
      .waitFor({ timeout: 20_000 })
      .catch(async (error: unknown) => {
        // Say what the panel showed instead (a refusal, a failed upload…).
        throw new Error(`${String(error)}\nThe card said: ${await card.innerText()}`);
      });
    const [pending] = await db<{ id: string; status: string }[]>`
      select id, status from public.asset_versions where asset_id = ${used.asset} and version = 2`;
    expect(pending?.status).toBe("processing");
    await page.reload();
    await expect(card.innerText()).resolves.toContain("Versión nueva (procesando)");

    // The pipeline's result.
    await db`
      update public.asset_versions
      set status = 'ready', mime = 'image/jpeg', bytes = 2000, width = 2048, height = 1024,
          sha256 = ${"c".repeat(64)}, ready_at = now(), manifest = ${db.json(PANO)}
      where id = ${pending!.id}`;
    await page.reload();
    await expect(card.innerText()).resolves.toContain("con la versión anterior");
    await accessible(page, "panoramas with a replacement ready");
    await card.getByRole("button", { name: "Usar la versión nueva en los tours" }).click();
    await card.getByText("Quedó en el borrador de 1 tour").waitFor({ timeout: 15_000 });

    const [state] = await db<{ draft: string; published: string }[]>`
      select (select s.panorama_version_id from public.tour_scenes s where s.tour_revision_id = t.draft_revision_id) as draft,
             (select s.panorama_version_id from public.tour_scenes s where s.tour_revision_id = t.published_revision_id) as published
      from public.tours t where t.id = ${tourId}`;
    expect(state).toEqual({ draft: pending!.id, published: used.version });

    // The one no tour used: deleted after confirming, its files to the cleanup.
    const spare = page.locator(`li[data-asset="${unused.asset}"]`);
    await expect(spare.innerText()).resolves.toContain("Ningún tour usa este panorama");
    const before = await page.locator("li.panorama-card").count();
    await spare.getByRole("button", { name: "Borrar" }).click();
    await accessible(page, "panoramas asking to confirm a deletion");
    await spare.getByRole("button", { name: "Sí, borrar" }).click();
    await expect
      .poll(() => page.locator("li.panorama-card").count(), { timeout: 15_000 })
      .toBe(before - 1);
    const jobs = await db`
      select 1 from public.background_jobs
      where tenant_id = ${SUR} and kind = 'media.remove_unused' and logical_key like 'deleted_version:%'`;
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    await page.context().close();
  }, 180_000);

  it("uses a photo as the model's image", async () => {
    const page = await signedIn(OWNER_EMAIL);
    await page.goto(`${ADMIN}/o/demo-sur/modelos`);
    const card = page.locator(`li[data-asset="${model.asset}"]`);
    await (
      await hydrated(card.locator('input[type=file][accept*="image/jpeg"]'))
    ).setInputFiles({
      name: "horno.jpg",
      mimeType: "image/jpeg",
      buffer: await sharp({
        create: { width: 1600, height: 1200, channels: 3, background: "#a63" },
      })
        .jpeg()
        .toBuffer(),
    });
    await card.getByText("Imagen actualizada con tu foto.").waitFor({ timeout: 20_000 });
    // The published tour that shows the model: the new image reaches visitors when it is
    // published again (its draft is ready for that).
    await expect(card.innerText()).resolves.toContain(
      "Un tour usa este modelo: publícalo de nuevo para que los visitantes vean la imagen nueva.",
    );
    const [row] = await db<{ poster: { file: string; width: number; height: number } }[]>`
      select manifest -> 'poster' as poster from public.asset_versions where id = ${model.version}`;
    expect(row?.poster).toMatchObject({ width: 1280, height: 960 });
    // Its own name: the public copy of the earlier poster is cached for a year.
    expect(row?.poster.file).toMatch(/^poster-[0-9a-f]{8}\.webp$/u);
    const [tour] = await db<{ draft: string | null }[]>`
      select draft_revision_id as draft from public.tours where id = ${tourId}`;
    expect(tour?.draft).not.toBeNull();
    await accessible(page, "models");
    await page.context().close();
  }, 120_000);

  it("an analyst sees where they are used, without replacing or deleting", async () => {
    const page = await signedIn(ANALYST_EMAIL);
    await page.goto(`${ADMIN}/o/demo-sur/panoramas`);
    const card = page.locator(`li[data-asset="${used.asset}"]`);
    await expect(card.innerText()).resolves.toContain(`Tour de «${TITLE}»`);
    expect(await card.getByText("Reemplazar el panorama").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Borrar" }).count()).toBe(0);
    await page.context().close();
  }, 90_000);
});
