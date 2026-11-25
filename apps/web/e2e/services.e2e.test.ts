/**
 * A · Paso 1.2 (ADR-069) in a real browser against the local stack:
 *
 * - the owner of Demo Sur creates a service in «Servicios locales»: a WhatsApp number without
 *   its country code and a service without an address or a location are rejected with their
 *   messages; with them it is published;
 * - visitors find it in /servicios under «Cajeros y bancos», with its anchor, «Llamar»,
 *   «WhatsApp» and «Cómo llegar»; the header and the footer link the page; the sitemap lists
 *   it; Demo Norte does not show it;
 * - in /mapa the «Servicios» layer starts off, and on from a service's card (`?servicios=1`);
 * - retiring it from the panel takes it off the portal;
 * - /servicios is checked with axe and for overflow at 390 and 1280 px.
 */
import axe from "axe-core";
import { chromium, type Browser, type Page } from "playwright-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { passSecondFactor } from "./support/second-factor";

const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = Number(process.env.RIKUY_PORT ?? 3000);
const ADMIN = `http://app.localhost:${PORT}`;
const PORTAL = `http://demo-sur.localhost:${PORT}`;
const NORTE = `http://demo-norte.localhost:${PORT}`;
const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SUR = "5eed1000-0000-4000-8000-000000000002";
const OWNER_SUR = "5eed0000-0000-4000-8000-000000000002";
const OWNER_EMAIL = "owner@demo-sur.example.test";
const STAMP = Date.now().toString(36);
const TITLE = `Cajero de la plaza ${STAMP}`;

const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
let browser: Browser;
let spot = { lat: -17.39, lng: -66.15 };

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

async function ownerPage(): Promise<Page> {
  const page = await (
    await browser.newContext({ viewport: { width: 1280, height: 900 } })
  ).newPage();
  await page.goto(`${ADMIN}/login`);
  await page.getByLabel("Correo electrónico").fill(OWNER_EMAIL);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const since = Date.now();
  await page.getByRole("button", { name: "Recibir código" }).click();
  await page.getByLabel("Código de acceso").fill(await emailCode(OWNER_EMAIL, since));
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });
  await passSecondFactor(page, ADMIN);
  return page;
}

async function visitorPage(): Promise<Page> {
  return (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
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

/** The service's card, once the portal shows it (its pages were marked stale on publishing). */
async function serviceCard(page: Page) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
    await page.goto(`${PORTAL}/servicios`);
    if ((await page.getByRole("heading", { name: TITLE }).count()) > 0) break;
  }
  return page.getByRole("article", { name: TITLE });
}

describe("local services of the municipality (ADR-069)", () => {
  beforeAll(async () => {
    // Next to a published destination of Demo Sur, so the map's area contains it.
    const [destination] = await db<{ lat: number; lng: number }[]>`
      select r.latitude as lat, r.longitude as lng
        from public.content_items ci
        join public.content_revisions r on r.id = ci.published_revision_id
       where ci.tenant_id = ${SUR} and ci.kind = 'destination' and r.latitude is not null
       order by ci.created_at limit 1`;
    if (destination) spot = { lat: destination.lat + 0.0005, lng: destination.lng + 0.0005 };
    browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
    });
  }, 60_000);

  afterAll(async () => {
    // Nothing of this test stays on the portal for the steps that follow.
    await db
      .begin(async (sql) => {
        await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: OWNER_SUR, role: "authenticated", aal: "aal2" })}, true)`;
        await sql`set local role authenticated`;
        const left = await sql<{ id: string }[]>`
          select ci.id from public.content_items ci
            join public.content_revisions r on r.id = ci.published_revision_id
           where ci.tenant_id = ${SUR} and ci.kind = 'service' and r.title = ${TITLE}`;
        for (const service of left) {
          await sql`select public.retire_content(${SUR}, ${service.id})`;
        }
      })
      .catch(() => undefined);
    await browser?.close();
    await db.end({ timeout: 5 });
  });

  it("publishes a service that visitors find in /servicios and on the map", async () => {
    const page = await ownerPage();
    await page.goto(`${ADMIN}/o/demo-sur`);
    await page.getByRole("link", { name: "Servicios locales" }).first().click();
    await page.waitForURL(/\/o\/demo-sur\/servicios/u);
    await page.goto(`${ADMIN}/o/demo-sur/servicios?nuevo`);
    await page.getByLabel("Nombre").fill(TITLE);
    await page.getByRole("button", { name: "Crear" }).click();
    await page.waitForURL(/\/o\/demo-sur\/servicios\/[0-9a-f-]{36}$/u, { timeout: 15_000 });

    await page.getByLabel("Categoría").selectOption({ label: "Cajero o banco" });
    await page.getByLabel("Descripción corta").fill("Cajero automático de la red nacional.");
    await page.getByLabel("Teléfono").fill("4 425 1234");
    // Without the country code the number cannot open WhatsApp.
    await page.getByLabel("WhatsApp").fill("70012345");
    await page.getByRole("button", { name: "Publicar" }).click();
    await page.getByText("con el código del país, por ejemplo +591").waitFor({ timeout: 15_000 });
    await page.getByLabel("WhatsApp").fill("+591 70012345");
    // Without an address or a place on the map, visitors could not find it.
    await page.getByRole("button", { name: "Publicar" }).click();
    await page
      .getByText("Escribe la dirección o marca el lugar en el mapa")
      .waitFor({ timeout: 15_000 });
    await page.getByLabel("Dirección").fill("Frente a la plaza principal");
    await page.getByLabel("Latitud").fill(spot.lat.toFixed(6));
    await page.getByLabel("Longitud").fill(spot.lng.toFixed(6));
    await page.getByRole("button", { name: "Publicar" }).click();
    await page
      .getByText("Publicado. Ya se ve en la página «Servicios» del portal.")
      .waitFor({ timeout: 15_000 });

    await page.goto(`${ADMIN}/o/demo-sur/servicios`);
    const row = page.getByRole("row", { name: new RegExp(TITLE) });
    await expect(row.innerText()).resolves.toContain("Publicado");

    // Visitors: the card under its category, with its anchor and its buttons.
    const visitor = await visitorPage();
    const card = await serviceCard(visitor);
    const slug = await card.getAttribute("id");
    expect(slug).toMatch(/^cajero-de-la-plaza-/u);
    await expect(
      visitor.getByRole("region", { name: "Cajeros y bancos" }).innerText(),
    ).resolves.toContain(TITLE);
    await expect(card.innerText()).resolves.toContain("Frente a la plaza principal");
    await expect(card.innerText()).resolves.toContain("Sin horario publicado");
    await expect(
      card.getByRole("link", { name: new RegExp(`^Llamar a ${TITLE}`) }).getAttribute("href"),
    ).resolves.toBe("tel:44251234");
    await expect(
      card.getByRole("link", { name: new RegExp(`^WhatsApp de ${TITLE}`) }).getAttribute("href"),
    ).resolves.toBe("https://wa.me/59170012345");
    await expect(
      card.getByRole("link", { name: new RegExp(`^Cómo llegar a ${TITLE}`) }).count(),
    ).resolves.toBe(1);
    await expect(
      visitor
        .getByRole("navigation", { name: "Principal" })
        .getByRole("link", { name: "Servicios" })
        .count(),
    ).resolves.toBe(1);
    await expect(
      visitor
        .getByRole("navigation", { name: "Para tu visita" })
        .getByRole("link", { name: /^Servicios/u })
        .getAttribute("href"),
    ).resolves.toBe("/servicios");
    await accessible(visitor, "/servicios");

    const sitemap = await (await fetch(`${PORTAL}/sitemap.xml`)).text();
    expect(sitemap).toContain("/servicios</loc>");

    // The map: the layer starts off, and on from the card.
    await visitor.goto(`${PORTAL}/mapa`);
    const list = visitor.getByRole("region", { name: "Lugares en esta zona" });
    await expect(visitor.getByLabel(/^Servicios \(\d+\)$/u).isChecked()).resolves.toBe(false);
    await expect(list.getByText(TITLE).count()).resolves.toBe(0);
    await visitor.goto(`${PORTAL}/servicios`);
    await card.getByRole("link", { name: "Ver en el mapa del municipio" }).click();
    await visitor.waitForURL(/\/mapa\?.*servicios=1/u);
    await expect(visitor.getByLabel(/^Servicios \(\d+\)$/u).isChecked()).resolves.toBe(true);
    const item = list.getByRole("link", { name: new RegExp(TITLE) });
    await item.waitFor({ timeout: 15_000 });
    await expect(item.innerText()).resolves.toContain("Servicio");
    await expect(item.getAttribute("href")).resolves.toBe(`/servicios#${String(slug)}`);

    // Demo Norte has its own services, never Demo Sur's.
    await visitor.goto(`${NORTE}/servicios`);
    await expect(visitor.getByText(TITLE).count()).resolves.toBe(0);

    // Retired from the panel (it closed): off the portal.
    await page.getByRole("link", { name: TITLE }).click();
    await page.getByRole("button", { name: "Retirar (cerró o ya no atiende)" }).click();
    const confirm = page.getByRole("button", {
      name: "Confirmar: retirar el servicio del portal y del asistente",
    });
    await confirm.click();
    await confirm.waitFor({ state: "detached", timeout: 15_000 });
    let shown = 1;
    for (let attempt = 0; attempt < 10 && shown > 0; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
      await visitor.goto(`${PORTAL}/servicios`);
      shown = await visitor.getByText(TITLE).count();
    }
    expect(shown).toBe(0);
  });
});
