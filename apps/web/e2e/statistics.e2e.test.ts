/**
 * C1 · Paso 2 (ADR-052) in a real browser against the local stack: «Estadísticas».
 *
 * - the owner of Demo Sur (with its second factor) sees its period's totals, the same the
 *   database adds up, compared with the period before; a place with its views and actions; the
 *   chart and its table; the origins; and downloads both CSVs of the period;
 * - an analyst sees the same page and downloads too;
 * - another municipality's page and download are 404, and so is a download without a session;
 * - the page is checked with axe and for overflow at 390 and 1280 px.
 */
import axe from "axe-core";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { passSecondFactor } from "./support/second-factor";

const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = Number(process.env.RIKUY_PORT ?? 3000);
const ADMIN = `http://app.localhost:${PORT}`;
const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SUR = "5eed1000-0000-4000-8000-000000000002";
const OWNER_SUR = "5eed0000-0000-4000-8000-000000000002";
const OWNER_EMAIL = "owner@demo-sur.example.test";
// Editor in Demo Norte, analyst in Demo Sur.
const ANALYST_EMAIL = "editor.ambos@example.test";
const STAMP = Date.now().toString(36);
const TITLE = `Mirador estadístico ${STAMP}`;
const PAGE = `${ADMIN}/o/demo-sur/estadisticas?periodo=7-dias`;

const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
let browser: Browser;
let placeId = "";
let yesterday = "";

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

async function signedIn(email: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  await page.goto(`${ADMIN}/login`);
  await page.getByLabel("Correo electrónico").fill(email);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const since = Date.now();
  await page.getByRole("button", { name: "Recibir código" }).click();
  await page.getByLabel("Código de acceso").fill(await emailCode(email, since));
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });
  await passSecondFactor(page, ADMIN);
  return { context, page };
}

async function accessible(page: Page) {
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(axe.source);
    const result = (await page.evaluate(() =>
      (window as unknown as { axe: { run: (context: Document) => Promise<unknown> } }).axe.run(
        document,
      ),
    )) as { violations: { id: string; impact: string | null }[] };
    expect(
      result.violations
        .filter((violation) => violation.impact === "critical" || violation.impact === "serious")
        .map((violation) => violation.id),
      `axe at ${width} px`,
    ).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      `overflow at ${width} px`,
    ).toBe(false);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function download(page: Page, name: RegExp): Promise<{ filename: string; body: string }> {
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name }).click(),
  ]);
  const stream = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return { filename: file.suggestedFilename(), body: Buffer.concat(chunks).toString("utf8") };
}

/** A tile's number, as the page shows it (es-BO thousands: «1.234»). */
async function tile(page: Page, label: string): Promise<{ value: number; text: string }> {
  const item = page.locator(".stats-tile").filter({ hasText: label });
  const value = Number((await item.locator(".stats-tile-value").innerText()).replaceAll(".", ""));
  return { value, text: await item.innerText() };
}

describe("«Estadísticas» of a municipality (ADR-052)", () => {
  beforeAll(async () => {
    // A published place of its own, and counts on known days: yesterday (in the period) and 10
    // days ago (in the period before). An old count makes the previous period «counted».
    const [day] = await db<{ yesterday: string }[]>`
      select ((now() at time zone 'America/La_Paz')::date - 1)::text as yesterday`;
    yesterday = day?.yesterday ?? "";
    placeId = await db.begin(async (sql) => {
      await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: OWNER_SUR, role: "authenticated", aal: "aal2" })}, true)`;
      await sql`set local role authenticated`;
      const [created] = await sql<{ content_id: string }[]>`
        select content_id from public.create_content_item(${SUR}, 'destination', ${`estadistica-${STAMP}`}, ${TITLE})`;
      if (!created) throw new Error("not created");
      const document = {
        title: TITLE,
        summary: "Para probar las estadísticas.",
        body: [],
        location: { lat: -17.6, lng: -65.9 },
        cover: null,
        gallery: [],
      };
      await sql`select * from public.save_content_draft(${SUR}, ${created.content_id}, ${sql.json(document)}, 1)`;
      await sql`select * from public.publish_content(${SUR}, ${created.content_id}, 2)`;
      return created.content_id;
    });
    await db`
      insert into public.visit_daily_counts (tenant_id, day, target, content_id, scene_id, event, views, visitors)
      values
        (${SUR}, ${yesterday}::date, 'destination', ${placeId}, null, 'view', 12, 9),
        (${SUR}, ${yesterday}::date, 'destination', ${placeId}, null, 'qr', 3, 3),
        (${SUR}, ${yesterday}::date, 'destination', ${placeId}, null, 'directions', 2, 2),
        (${SUR}, ${yesterday}::date - 10, 'destination', ${placeId}, null, 'qr', 1, 1),
        (${SUR}, ${yesterday}::date - 30, 'home', null, null, 'view', 1, 1)
      on conflict on constraint visit_daily_counts_key do update
        set views = excluded.views, visitors = excluded.visitors`;
    await db`
      insert into public.visit_daily_origins (tenant_id, day, country, city, views, visitors)
      values (${SUR}, ${yesterday}::date, 'PE', ${`Cusco ${STAMP}`}, 5, 4)
      on conflict on constraint visit_daily_origins_key do update
        set views = excluded.views, visitors = excluded.visitors`;
    browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await db.end({ timeout: 5 });
  });

  it("shows the owner the period's numbers, compared, and downloads them", async () => {
    const { context, page } = await signedIn(OWNER_EMAIL);
    await page.goto(`${ADMIN}/o/demo-sur`);
    await page.getByRole("link", { name: /Estadísticas/u }).click();
    await page.waitForURL(/\/o\/demo-sur\/estadisticas$/u);
    await expect
      .poll(() => page.getByRole("link", { name: "Últimos 30 días" }).getAttribute("aria-current"))
      .toBe("page");

    await page.goto(PAGE);
    expect(
      await page.getByRole("link", { name: "Últimos 7 días" }).getAttribute("aria-current"),
    ).toBe("page");
    await expect.poll(() => page.locator(".stats-range").innerText()).toMatch(/comparado con/u);

    // The tiles say what the database adds up for the same days.
    const [sums] = await db<{ views: number; qr: number; previous_qr: number }[]>`
      select
        coalesce(sum(views) filter (where event = 'view' and day >= ${yesterday}::date - 5), 0)::int as views,
        coalesce(sum(views) filter (where event = 'qr' and day >= ${yesterday}::date - 5), 0)::int as qr,
        coalesce(sum(views) filter (where event = 'qr' and day < ${yesterday}::date - 5), 0)::int as previous_qr
      from public.visit_daily_counts
      where tenant_id = ${SUR} and day between ${yesterday}::date - 12 and ${yesterday}::date + 1`;
    expect((await tile(page, "Vistas de páginas")).value).toBe(sums?.views);
    const qr = await tile(page, "Escaneos de QR");
    expect(qr.value).toBe(sums?.qr);
    expect(sums?.previous_qr).toBeGreaterThan(0);
    expect(qr.text).toMatch(/[▲▼=]/u);

    // The place, with its views and actions; it links to its editor.
    const row = page.getByRole("row").filter({ hasText: TITLE });
    await expect.poll(() => row.count()).toBe(1);
    expect((await row.locator("td").allInnerTexts()).slice(0, 4)).toEqual(["12", "9", "3", "2"]);
    expect(await row.getByRole("link", { name: TITLE }).getAttribute("href")).toBe(
      `/o/demo-sur/destinos/${placeId}`,
    );
    // The chart has its words; the day's numbers are in the table.
    expect(await page.locator(".stats-chart svg").getAttribute("aria-label")).toMatch(
      /^Vistas por día: /u,
    );
    await page.getByText("Ver los números de cada día").click();
    expect(
      await page
        .getByRole("region", { name: "Vistas y visitantes por día" })
        .getByRole("row")
        .count(),
    ).toBe(8);
    await expect.poll(() => page.getByText(`Cusco ${STAMP}`).count()).toBe(1);
    expect(await page.getByText("Perú").count()).toBeGreaterThan(0);

    const visits = await download(page, /Visitas por día/u);
    expect(visits.filename).toMatch(
      /^demo-sur-visitas-\d{4}-\d{2}-\d{2}-a-\d{4}-\d{2}-\d{2}\.csv$/u,
    );
    expect(visits.body.startsWith("﻿fecha;página;lugar;")).toBe(true);
    expect(visits.body).toContain(
      `${yesterday};Ficha de destino;${TITLE};estadistica-${STAMP};;Escaneo de QR;3;3`,
    );
    const origins = await download(page, /Origen por día/u);
    expect(origins.body).toContain(`${yesterday};PE;Cusco ${STAMP};5;4`);

    await accessible(page);

    // Another municipality's statistics and downloads do not exist for this person.
    const norte = await page.goto(`${ADMIN}/o/demo-norte/estadisticas`);
    expect(norte?.status()).toBe(404);
    // (Navigations: a 404 is a page, not a download.)
    const foreign = await page.goto(
      `${ADMIN}/o/demo-norte/estadisticas/descargar?periodo=7-dias&tipo=visitas`,
    );
    expect(foreign?.status()).toBe(404);
    const unknown = await page.goto(
      `${ADMIN}/o/demo-sur/estadisticas/descargar?periodo=7-dias&tipo=otra`,
    );
    expect(unknown?.status()).toBe(404);
    await context.close();
  });

  it("is the same for an analyst, and nothing without a session", async () => {
    const { context, page } = await signedIn(ANALYST_EMAIL);
    await page.goto(PAGE);
    const row = page.getByRole("row").filter({ hasText: TITLE });
    await expect.poll(() => row.count()).toBe(1);
    const visits = await download(page, /Visitas por día/u);
    expect(visits.body).toContain(`${TITLE}`);
    await context.close();

    const anonymous = await browser.newContext();
    const response = await (
      await anonymous.newPage()
    ).goto(`${ADMIN}/o/demo-sur/estadisticas/descargar?periodo=7-dias&tipo=visitas`);
    expect(response?.status()).toBe(404);
    expect(await response?.text()).not.toContain(TITLE);
    await anonymous.close();
  });
});
