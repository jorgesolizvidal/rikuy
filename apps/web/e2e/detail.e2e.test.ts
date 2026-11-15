/**
 * C3 · Paso 4 (ADR-063) in a real browser against the local stack: a destination's and an
 * event's page, and the map.
 *
 * - the page opens with its cover, its category and its real badges, the «Para tu visita»
 *   card (hours, «Cómo llegar», the passport's circuit), «Eventos en este lugar» and «Cerca de
 *   aquí» from published data only (never a draft, never another municipality);
 * - an event says how far it is with the municipality's clock («En 3 días», «En curso»), and
 *   an ended one says so without the status;
 * - the photos open large on the same page: «Foto 1 de 2», arrows, «Siguiente» past the last
 *   photo, Escape, and the focus back on the photo that opened it (the owner adds two photos
 *   to the plaza in the panel first; this step runs last in its job);
 * - the map: the list beside the map on a computer and below it on a phone, filtered by the
 *   municipality's categories;
 * - axe without critical or serious findings and no overflow at 390 and 1280 px.
 */
import { request as httpRequest } from "node:http";

import axe from "axe-core";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { passSecondFactor } from "./support/second-factor";

const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = Number(process.env.RIKUY_PORT ?? 3000);
const ADMIN = `http://app.localhost:${PORT}`;
const NORTE = `http://demo-norte.localhost:${PORT}`;
const SUR = `http://demo-sur.localhost:${PORT}`;
const OWNER_NORTE = "owner@demo-norte.example.test";
const PLAZA = "5eed4100-0000-4000-8000-000000000004";
const DAY = 86_400_000;

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

async function signIn(email: string): Promise<Page> {
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

async function portalPage(width = 1280): Promise<Page> {
  return (await browser.newContext({ viewport: { width, height: 900 } })).newPage();
}

async function accessible(page: Page, label: string, widths = [390, 1280]) {
  for (const width of widths) {
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
      `${label} at ${width} px`,
    ).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      `${label} overflows at ${width} px`,
    ).toBe(false);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** A portal page's HTML (node:http keeps the portal's Host). */
function html(url: string): Promise<string> {
  const { host, pathname, search } = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port: PORT, path: `${pathname}${search}`, headers: { host } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

/** Waits until the portal's HTML matches (publishing refreshes the cached pages). */
async function until(url: string, test: (page: string) => boolean): Promise<string> {
  const deadline = Date.now() + 20_000;
  let page = "";
  while (Date.now() < deadline) {
    page = await html(url);
    if (test(page)) return page;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return page;
}

/** Before React hydrates a file input, choosing a file starts nothing. */
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

/** The event's start, from its calendar file (`DTSTART:20261124T140000Z`). */
async function eventStart(slug: string): Promise<number> {
  const ics = await html(`${NORTE}/agenda/${slug}/calendario.ics`);
  const match = /DTSTART:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/u.exec(ics);
  if (!match) throw new Error(`no DTSTART for ${slug}`);
  const [, y, mo, d, h, mi, s] = match.map(Number);
  return Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, s ?? 0);
}

async function photo(color: string): Promise<Buffer> {
  return sharp({ create: { width: 1200, height: 800, channels: 3, background: color } })
    .jpeg()
    .toBuffer();
}

describe("destination and event pages, and the map (ADR-063)", () => {
  beforeAll(async () => {
    browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("a destination: cover, visit card, events here and «Cerca de aquí», published only", async () => {
    const page = await portalPage();
    await page.goto(`${NORTE}/destinos/mirador-del-valle`);

    const hero = page.locator(".portal-detail-hero");
    await expect
      .poll(() => hero.getByRole("heading", { level: 1 }).innerText())
      .toBe("Mirador del Valle");
    expect(await hero.locator(".portal-kicker").textContent()).toBe("Miradores");
    expect(await hero.locator(".portal-flag").allInnerTexts()).toEqual(["Sello del pasaporte"]);

    const visit = page.getByRole("complementary", { name: "Para tu visita" });
    await expect.poll(() => visit.locator(".portal-open-now").innerText()).toMatch(/^Abierto/u);
    expect(await visit.getByRole("link", { name: /Cómo llegar/u }).count()).toBe(1);
    expect(await visit.getByRole("link", { name: "Ruta del valle" }).getAttribute("href")).toBe(
      "/pasaporte/ruta-del-valle",
    );

    const here = page.getByRole("region", { name: "Eventos en este lugar" });
    expect(await here.locator(".portal-event-title").allInnerTexts()).toEqual(["Feria del choclo"]);

    const near = page.getByRole("region", { name: "Cerca de aquí" });
    const names = await near.locator(".portal-close-title").allInnerTexts();
    expect(names[0]).toBe("Plaza principal");
    // The event at this very place is under «Eventos en este lugar», not again here; a draft
    // (Feria de los domingos) and Demo Sur's places never are.
    expect(names).not.toContain("Feria del choclo");
    expect(names).not.toContain("Feria de los domingos");
    expect(names).not.toContain("Laguna Azul");
    expect(await near.locator(".portal-close-distance").first().innerText()).toMatch(
      /^A [\d.,]+ (m|km) en línea recta$/u,
    );
    // From the page's own place: the HTML is the same for every visitor (cached).
    expect(await html(`${NORTE}/destinos/mirador-del-valle`)).toContain("Cerca de aquí");

    await accessible(page, "destination page");
    await page.context().close();
  });

  it("an event says how far it is with the municipality's clock; an ended one does not", async () => {
    const start = await eventStart("feria-del-choclo");
    const page = await portalPage(390);
    await page.clock.setFixedTime(new Date(start - 3 * DAY));
    await page.goto(`${NORTE}/agenda/feria-del-choclo`);
    const hero = page.locator(".portal-detail-hero");
    expect(await hero.locator(".portal-event-day").innerText()).toMatch(/^\d{1,2}$/u);
    expect(await hero.locator(".portal-kicker").textContent()).toBe("Ferias");
    const status = page.locator(".portal-event-status");
    await expect.poll(() => status.innerText()).toBe("En 3 días");
    expect(await page.getByRole("link", { name: "Mirador del Valle" }).count()).toBeGreaterThan(0);
    expect(await page.getByRole("link", { name: "Añadir al calendario" }).count()).toBe(1);
    await accessible(page, "event page");
    await page.context().close();

    const later = await portalPage();
    await later.clock.setFixedTime(new Date(start + 60_000));
    await later.goto(`${NORTE}/agenda/feria-del-choclo`);
    await expect.poll(() => later.locator(".portal-event-status").innerText()).toBe("En curso");
    await later.context().close();

    const ended = await portalPage();
    await ended.goto(`${NORTE}/agenda/festival-de-invierno`);
    expect(await ended.getByRole("status").filter({ hasText: "ya terminó" }).count()).toBe(1);
    expect(await ended.locator(".portal-event-status").count()).toBe(0);
    expect(await ended.getByRole("link", { name: "Añadir al calendario" }).count()).toBe(0);
    expect(await ended.getByRole("region", { name: "Cerca de aquí" }).count()).toBe(0);
    await ended.context().close();
  });

  it("the photos open large on the same page and give the focus back", async () => {
    const admin = await signIn(OWNER_NORTE);
    await admin.goto(`${ADMIN}/o/demo-norte/destinos/${PLAZA}`);
    const gallery = admin.locator("fieldset.photo-field").nth(1);
    await (
      await hydrated(gallery.locator("input[type=file]"))
    ).setInputFiles([
      { name: "uno.jpg", mimeType: "image/jpeg", buffer: await photo("#2f6b3f") },
      { name: "dos.jpg", mimeType: "image/jpeg", buffer: await photo("#b45309") },
    ]);
    const descriptions = gallery.getByLabel(/Descripción/u);
    await expect.poll(() => descriptions.count(), { timeout: 60_000 }).toBe(2);
    await descriptions.nth(0).fill("Árboles de la plaza");
    await descriptions.nth(1).fill("La pileta al mediodía");
    await admin.getByRole("button", { name: "Publicar" }).click();
    await expect
      .poll(() => admin.getByText(/^Publicado/u).count(), { timeout: 30_000 })
      .toBeGreaterThan(0);
    await admin.context().close();
    await until(`${NORTE}/destinos/plaza-principal`, (body) => body.includes("La pileta"));

    const page = await portalPage();
    await page.goto(`${NORTE}/destinos/plaza-principal`);
    const links = page.locator(".portal-gallery-link");
    expect(await links.count()).toBe(2);
    // Without JavaScript each photo is a link to its largest derivative.
    expect(await links.first().getAttribute("href")).toMatch(/^\/medios\//u);
    await links.first().click();
    const dialog = page.getByRole("dialog", { name: "Foto 1 de 2" });
    await dialog.waitFor();
    expect(await dialog.locator("img").getAttribute("alt")).toBe("Árboles de la plaza");
    expect(page.url()).toBe(`${NORTE}/destinos/plaza-principal`);
    await accessible(page, "photo dialog", [1280]);

    await page.keyboard.press("ArrowRight");
    await page.getByRole("dialog", { name: "Foto 2 de 2" }).waitFor();
    await page.getByRole("button", { name: "Siguiente" }).click();
    await page.getByRole("dialog", { name: "Foto 1 de 2" }).waitFor();
    await page.keyboard.press("Escape");
    await expect.poll(() => page.getByRole("dialog").count()).toBe(0);
    expect(await links.first().evaluate((element) => element === document.activeElement)).toBe(
      true,
    );
    await page.context().close();
  });

  it("the map: the list beside it on a computer, below on a phone, by category", async () => {
    const page = await portalPage();
    await page.goto(`${NORTE}/mapa`);
    const list = page.getByRole("region", { name: "Lugares en esta zona" });
    const titles = () => list.locator(".portal-map-title").allInnerTexts();
    await expect.poll(async () => (await titles()).length).toBeGreaterThan(1);
    const all = await titles();
    expect(all).toContain("Mirador del Valle");
    expect(all).toContain("Plaza principal");

    const chips = page.getByRole("group", { name: "Categoría" });
    expect(await chips.getByRole("button").allInnerTexts()).toEqual([
      "Todas",
      "Ferias",
      "Miradores",
      "Plazas y centro",
    ]);
    await chips.getByRole("button", { name: "Miradores" }).click();
    await expect.poll(titles).toEqual(["Mirador del Valle"]);
    expect(
      await chips.getByRole("button", { name: "Miradores" }).getAttribute("aria-pressed"),
    ).toBe("true");
    await chips.getByRole("button", { name: "Todas" }).click();
    await expect.poll(async () => (await titles()).length).toBe(all.length);

    const frame = page.locator(".portal-map-frame");
    const beside = async () => {
      const [a, b] = await Promise.all([list.boundingBox(), frame.boundingBox()]);
      return { listLeft: a?.x ?? 0, mapLeft: b?.x ?? 0, listTop: a?.y ?? 0, mapTop: b?.y ?? 0 };
    };
    const wide = await beside();
    expect(wide.listLeft).toBeLessThan(wide.mapLeft);
    await page.setViewportSize({ width: 390, height: 900 });
    const narrow = await beside();
    expect(narrow.mapTop).toBeLessThan(narrow.listTop);
    await accessible(page, "map");

    // Demo Sur has its own categories, never Demo Norte's.
    await page.goto(`${SUR}/mapa`);
    await page.getByRole("region", { name: "Lugares en esta zona" }).waitFor();
    const sur = page.getByRole("group", { name: "Categoría" });
    if ((await sur.count()) > 0) {
      expect(await sur.getByRole("button").allInnerTexts()).not.toContain("Miradores");
    }
    await page.context().close();
  });
});
