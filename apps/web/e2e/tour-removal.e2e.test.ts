/**
 * C0 · Paso 3 (ADR-049) in a real browser against the local stack, in Demo Sur:
 *
 * - the owner moves a published tour to another destination from its editor; the
 *   confirmation names the tour whose "go to another tour" point leads to the old place; the
 *   old tour page, cached by visitors, now leads to the new one;
 * - the owner deletes it; the panel goes back to the list, nothing of it is left, and both
 *   tour pages lead to their places;
 * - an analyst sees no way to move or delete a tour;
 * - the section is checked with axe and for overflow at 390 and 1280 px.
 */
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";

import axe from "axe-core";
import { chromium, type Browser, type Page } from "playwright-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { passSecondFactor } from "./support/second-factor";

const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = Number(process.env.RIKUY_PORT ?? 3000);
const ADMIN = `http://app.localhost:${PORT}`;
const PORTAL_HOST = `demo-sur.localhost:${PORT}`;
const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SUR = "5eed1000-0000-4000-8000-000000000002";
const OWNER_SUR = "5eed0000-0000-4000-8000-000000000002";
const OWNER_EMAIL = "owner@demo-sur.example.test";
const ANALYST_EMAIL = "editor.ambos@example.test";
const STAMP = Date.now().toString(36);
const ORIGIN = `origen-${STAMP}`;
const TARGET = `destino-${STAMP}`;
const LINKER = `enlace-${STAMP}`;
const MANIFEST = {
  version: 1,
  projection: "equirectangular",
  source: { width: 4096, height: 2048, bytes: 1000, mime: "image/jpeg", sha256: "a".repeat(64) },
  preview: { file: "preview.webp", width: 256, height: 128, bytes: 1000 },
  image: { file: "image.webp", width: 512, height: 256, bytes: 2000 },
  tiles: null,
};

const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
let browser: Browser;
const ids = { tour: "", linkerTour: "" };

/** One request to the portal as a visitor would send it, without following redirects. */
function visit(path: string): Promise<{ status: number; location: string | undefined }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port: PORT, path, headers: { host: PORTAL_HOST } },
      (response) => {
        response.resume();
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, location: response.headers.location }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

const pathOf = (location: string | undefined) =>
  location ? new URL(location, `http://${PORTAL_HOST}`).pathname : null;

/**
 * As the owner of Demo Sur, through the same RPCs as the panel: three published places, a
 * public panorama, a published tour of the first one and one of the third with a point
 * leading to the first.
 */
async function setUp(): Promise<void> {
  const panorama = { asset: randomUUID(), version: randomUUID() };
  await db`insert into public.assets (id, tenant_id, purpose) values (${panorama.asset}, ${SUR}, 'panorama')`;
  await db`
    insert into public.asset_versions (id, tenant_id, asset_id, version, status, declared_mime, declared_bytes,
                                       mime, bytes, width, height, sha256, ready_at, manifest, published_at)
    values (${panorama.version}, ${SUR}, ${panorama.asset}, 1, 'ready', 'image/jpeg', 1000, 'image/jpeg', 1000,
            4096, 2048, ${"e".repeat(64)}, now(), ${db.json(MANIFEST)}, now())
  `;
  await db.begin(async (sql) => {
    await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: OWNER_SUR, role: "authenticated", aal: "aal2" })}, true)`;
    await sql`set local role authenticated`;
    const place: Record<string, string> = {};
    for (const [slug, title] of [
      [ORIGIN, `Origen ${STAMP}`],
      [TARGET, `Destino ${STAMP}`],
      [LINKER, `Enlace ${STAMP}`],
    ] as const) {
      const [created] = await sql<{ content_id: string }[]>`
        select content_id from public.create_content_item(${SUR}, 'destination', ${slug}, ${title})`;
      const document = {
        title,
        summary: "Para probar borrar y mover tours.",
        body: [],
        location: { lat: -17.6, lng: -65.9 },
        cover: null,
        gallery: [],
      };
      await sql`select * from public.save_content_draft(${SUR}, ${created!.content_id}, ${sql.json(document)}, 1)`;
      await sql`select * from public.publish_content(${SUR}, ${created!.content_id}, 2)`;
      place[slug] = created!.content_id;
    }
    for (const slug of [ORIGIN, LINKER]) {
      const [tour] = await sql<{ tour_id: string }[]>`
        select tour_id from public.create_tour(${SUR}, ${place[slug]!})`;
      const [scene] = await sql<{ scene_id: string; edit_count: number }[]>`
        select scene_id, edit_count from public.add_tour_scene(${SUR}, ${tour!.tour_id}, 1, ${panorama.version}, 'Sala')`;
      let edit = scene!.edit_count;
      if (slug === LINKER) {
        const [point] = await sql<{ edit_count: number }[]>`
          select edit_count from public.add_tour_hotspot(${SUR}, ${tour!.tour_id}, ${edit}, ${scene!.scene_id},
            ${sql.json({ kind: "tour", title: "Ir al origen", position: { yaw: 0, pitch: 0 }, targetContentId: place[ORIGIN]! })})`;
        edit = point!.edit_count;
        ids.linkerTour = tour!.tour_id;
      } else {
        ids.tour = tour!.tour_id;
      }
      await sql`select * from public.publish_tour(${SUR}, ${tour!.tour_id}, ${edit})`;
    }
  });
}

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

describe("deleting and moving a tour (ADR-049)", () => {
  beforeAll(async () => {
    await setUp();
    browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    // The other suites read Demo Sur's tours: the tour that linked here goes too.
    await db.begin(async (sql) => {
      await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: OWNER_SUR, role: "authenticated", aal: "aal2" })}, true)`;
      await sql`set local role authenticated`;
      if (ids.linkerTour) await sql`select * from public.delete_tour(${SUR}, ${ids.linkerTour})`;
    });
    await db.end({ timeout: 5 });
  });

  it("moves a published tour, then deletes it; old tour pages lead where it is", async () => {
    // Visitors opened both pages before: they are in the portal's cache.
    expect((await visit(`/destinos/${ORIGIN}/tour`)).status).toBe(200);
    expect((await visit(`/destinos/${LINKER}/tour`)).status).toBe(200);

    const page = await signedIn(OWNER_EMAIL);
    await page.goto(`${ADMIN}/o/demo-sur/tours/${ids.tour}`);
    const section = page.locator("section.tour-removal");
    await expect(section.innerText()).resolves.toContain("Tiene 1 versión publicada.");
    await section.getByLabel("Pasar a").selectOption({ label: `Destino ${STAMP}` });
    await section.getByRole("button", { name: "Pasar el tour…" }).click();
    const confirmation = await section.locator(".confirm-box").innerText();
    expect(confirmation).toContain(`«Origen ${STAMP}» se queda sin tour`);
    expect(confirmation).toContain(`Tour de Enlace ${STAMP} · publicado`);
    await accessible(page, "moving a tour");
    await section.getByRole("button", { name: "Sí, pasar el tour" }).click();
    await section
      .getByText(`El tour pasó a «Destino ${STAMP}». Su dirección anterior lleva a la nueva.`)
      .waitFor({ timeout: 15_000 });
    await page.getByRole("heading", { name: `Tour de Destino ${STAMP}` }).waitFor();

    // Visitors: the old page leads to the new one, which opens.
    const moved = await visit(`/destinos/${ORIGIN}/tour`);
    expect(moved.status).toBe(307);
    expect(pathOf(moved.location)).toBe(`/destinos/${TARGET}/tour`);
    expect((await visit(`/destinos/${TARGET}/tour`)).status).toBe(200);

    // Deleting asks first, then goes back to the list.
    await section.getByRole("button", { name: "Borrar el tour…" }).click();
    const asked = await section.locator(".confirm-box").innerText();
    expect(asked).toContain(`¿Borrar el tour de «Destino ${STAMP}»?`);
    expect(asked).toContain("No se puede deshacer.");
    await accessible(page, "deleting a tour");
    await section.getByRole("button", { name: "Sí, borrar el tour" }).click();
    await page.waitForURL(`${ADMIN}/o/demo-sur/tours`, { timeout: 15_000 });
    const [left] = await db<{ tours: number; revisions: number }[]>`
      select (select count(*)::int from public.tours where id = ${ids.tour}) as tours,
             (select count(*)::int from public.tour_revisions where tour_id = ${ids.tour}) as revisions`;
    expect(left).toEqual({ tours: 0, revisions: 0 });

    // Visitors: both tour pages lead to their places; the tour that linked here still opens.
    for (const slug of [ORIGIN, TARGET]) {
      const response = await visit(`/destinos/${slug}/tour`);
      expect(response.status, slug).toBe(307);
      expect(pathOf(response.location)).toBe(`/destinos/${slug}`);
    }
    expect((await visit(`/destinos/${LINKER}/tour`)).status).toBe(200);
    await page.context().close();
  }, 180_000);

  it("an analyst sees no way to move or delete a tour", async () => {
    const page = await signedIn(ANALYST_EMAIL);
    await page.goto(`${ADMIN}/o/demo-sur/tours/${ids.linkerTour}`);
    await page.getByRole("heading", { name: `Tour de Enlace ${STAMP}` }).waitFor();
    expect(await page.locator("section.tour-removal").count()).toBe(0);
    await page.context().close();
  }, 120_000);
});
