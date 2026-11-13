/**
 * C2 · Paso 4 (ADR-059) in a real browser against the local stack: the tourist passport in
 * «Estadísticas» and the monthly report.
 *
 * - a phone stamps the plaza of Demo Norte twice the same day and once more from the place:
 *   the plaza counts one stamp and one visit verified on the spot, nothing else;
 * - the owner (with its second factor) sees «Pasaporte turístico» in «Estadísticas» with the
 *   same totals the database adds up (stamps, verified visits, completed circuits, prizes),
 *   each place with the views of its page next to its stamps, the circuit, and downloads the
 *   CSV per day; the monthly report has the same section; both pages pass axe and do not
 *   overflow at 390 and 1280 px;
 * - Demo Sur, without circuits, has no passport section.
 */
import { request as httpRequest } from "node:http";

import axe from "axe-core";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { passSecondFactor } from "./support/second-factor";

const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = Number(process.env.RIKUY_PORT ?? 3000);
const ADMIN = `http://app.localhost:${PORT}`;
const NORTE = `http://demo-norte.localhost:${PORT}`;
const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const NORTE_ID = "5eed1000-0000-4000-8000-000000000001";
const OWNER_EMAIL = "owner@demo-norte.example.test";
// Editor in Demo Norte, analyst in Demo Sur.
const ANALYST_SUR_EMAIL = "editor.ambos@example.test";
const COUNT = new Intl.NumberFormat("es-BO");

const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
let browser: Browser;

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

/** POST /sellar as a page of the portal would (node:http keeps the portal's Host). */
function stamp(body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: PORT,
        path: "/sellar",
        method: "POST",
        headers: {
          host: `demo-norte.localhost:${PORT}`,
          origin: NORTE,
          "content-type": "application/json",
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

async function plazaToday(): Promise<{ stamps: number; located: number }> {
  const [row] = await db<{ stamps: number; located: number }[]>`
    select coalesce(sum(d.stamps), 0)::int as stamps, coalesce(sum(d.located), 0)::int as located
    from public.passport_daily_stamps d
    join public.content_items i on i.id = d.content_id
    where d.tenant_id = ${NORTE_ID} and i.slug = 'plaza-principal'
      and d.day = (now() at time zone 'America/La_Paz')::date`;
  return row ?? { stamps: 0, located: 0 };
}

/** What the database adds up for the last 30 days of Demo Norte. */
async function expected() {
  const [row] = await db<
    { stamps: number; located: number; completed: number; redeemed: number }[]
  >`
    with days as (
      select (now() at time zone 'America/La_Paz')::date - 29 as since,
             (now() at time zone 'America/La_Paz')::date as until
    )
    select
      (select coalesce(sum(stamps), 0)::int from public.passport_daily_stamps, days
       where tenant_id = ${NORTE_ID} and day between since and until) as stamps,
      (select coalesce(sum(located), 0)::int from public.passport_daily_stamps, days
       where tenant_id = ${NORTE_ID} and day between since and until) as located,
      (select count(distinct passport_hash)::int from public.passport_vouchers, days
       where tenant_id = ${NORTE_ID}
         and (issued_at at time zone 'America/La_Paz')::date between since and until) as completed,
      (select count(*)::int from public.passport_vouchers, days
       where tenant_id = ${NORTE_ID} and redeemed_at is not null
         and (redeemed_at at time zone 'America/La_Paz')::date between since and until) as redeemed`;
  if (!row) throw new Error("no totals");
  return row;
}

describe("the tourist passport in «Estadísticas» (ADR-059)", () => {
  beforeAll(async () => {
    browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await db.end({ timeout: 5 });
  });

  it("counts a phone once per place and day, and shows it to the municipality", async () => {
    const [plaza] = await db<{ code: string }[]>`
      select k.code from public.passport_stamp_codes k
      join public.content_items i on i.id = k.content_id
      where k.tenant_id = ${NORTE_ID} and i.slug = 'plaza-principal'`;
    const passport = `Metricas${Date.now().toString(36)}`.padEnd(22, "x").slice(0, 22);
    const before = await plazaToday();
    expect(await stamp({ code: plaza!.code, passport, located: false })).toBe(200);
    expect(await stamp({ code: plaza!.code, passport, located: false })).toBe(200);
    expect(await plazaToday()).toEqual({ stamps: before.stamps + 1, located: before.located });
    expect(await stamp({ code: plaza!.code, passport, located: true })).toBe(200);
    expect(await stamp({ code: plaza!.code, passport, located: true })).toBe(200);
    expect(await plazaToday()).toEqual({
      stamps: before.stamps + 1,
      located: before.located + 1,
    });

    const { context, page } = await signedIn(OWNER_EMAIL);
    await page.goto(`${ADMIN}/o/demo-norte/estadisticas`);
    const section = page.locator("section", {
      has: page.getByRole("heading", { level: 2, name: "Pasaporte turístico" }),
    });
    await section.waitFor();
    const totals = await expected();
    const tile = (label: string) =>
      section
        .locator(".stats-tile", { has: page.locator(".stats-tile-label", { hasText: label }) })
        .filter({ has: page.getByText(label, { exact: true }) })
        .locator(".stats-tile-value")
        .innerText();
    expect(await tile("Sellos")).toBe(COUNT.format(totals.stamps));
    expect(await tile("Visitas comprobadas en el lugar")).toBe(COUNT.format(totals.located));
    expect(await tile("Circuitos completados")).toBe(COUNT.format(totals.completed));
    expect(await tile("Premios canjeados")).toBe(COUNT.format(totals.redeemed));

    // Each place: the views of its page next to its stamps; the never-published stop is not there.
    const row = section.locator("tr", { has: page.getByRole("link", { name: "Plaza principal" }) });
    await expect.poll(() => row.count()).toBe(1);
    expect(await row.getByRole("link", { name: "Plaza principal" }).getAttribute("href")).toMatch(
      /^\/o\/demo-norte\/destinos\/5eed4100-0000-4000-8000-000000000004$/u,
    );
    expect(await section.getByText("Feria de los domingos").count()).toBe(0);
    expect(await section.getByRole("link", { name: "Ruta del valle" }).getAttribute("href")).toBe(
      "/o/demo-norte/pasaporte/5eed4600-0000-4000-8000-000000000001",
    );
    await accessible(page);

    // The CSV of the period, per day.
    const [file] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: /Pasaporte turístico por día/u }).click(),
    ]);
    expect(file.suggestedFilename()).toMatch(/^demo-norte-pasaporte-\d{4}-\d{2}-\d{2}-a-/u);
    const chunks: Buffer[] = [];
    for await (const chunk of await file.createReadStream()) chunks.push(chunk as Buffer);
    const csv = Buffer.concat(chunks).toString("utf8");
    expect(csv.startsWith("﻿fecha;tipo;nombre;dirección;sellos;sellos con ubicación")).toBe(true);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/La_Paz" }).format(
      new Date(),
    );
    const now = await plazaToday();
    expect(csv).toContain(
      `${today};Sellos de un lugar;Plaza principal;plaza-principal;${now.stamps};${now.located};;`,
    );

    // The monthly report of this month has the same section.
    await page.goto(`${ADMIN}/o/demo-norte/informe?mes=${today.slice(0, 7)}`);
    const report = page.locator("section", {
      has: page.getByRole("heading", { level: 2, name: "Pasaporte turístico" }),
    });
    await report.waitFor();
    expect(await report.getByRole("link", { name: "Ruta del valle" }).count()).toBe(1);
    await accessible(page);
    await context.close();
  });

  it("is not shown where there are no circuits", async () => {
    const { context, page } = await signedIn(ANALYST_SUR_EMAIL);
    await page.goto(`${ADMIN}/o/demo-sur/estadisticas`);
    await page.getByRole("heading", { level: 2, name: "Resumen" }).waitFor();
    expect(await page.getByRole("heading", { name: "Pasaporte turístico" }).count()).toBe(0);
    expect(await page.getByRole("link", { name: /Pasaporte turístico por día/u }).count()).toBe(0);
    await context.close();
  });
});
