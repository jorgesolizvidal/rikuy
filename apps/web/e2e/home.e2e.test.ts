/**
 * C3 · Paso 3 (ADR-062) in a real browser against the local stack: the home by sections,
 * the municipality's categories and the phone's bottom bar.
 *
 * - Demo Sur arranges its own home (figures with its own «4.100 m», events as cards first,
 *   one featured destination); Demo Norte keeps the platform's default order;
 * - the destinations and the agenda filter by the municipality's categories in the browser,
 *   the address keeps the filter, and a category only shows when something published has it;
 * - on a phone the header's links move to a bottom bar with what the municipality has, the
 *   current section marked; on a computer the bar is not there;
 * - the owner of Demo Norte manages its categories and its home in the panel: a duplicate
 *   name is refused, a destination picks its category, the home's order and figure reach the
 *   portal at the next visit; everything is put back as the seed had it.
 */
import { request as httpRequest } from "node:http";

import axe from "axe-core";
import { chromium, type Browser, type Page } from "playwright-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { passSecondFactor } from "./support/second-factor";

const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = Number(process.env.RIKUY_PORT ?? 3000);
const ADMIN = `http://app.localhost:${PORT}`;
const SUR = `http://demo-sur.localhost:${PORT}`;
const NORTE = `http://demo-norte.localhost:${PORT}`;
const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const NORTE_ID = "5eed1000-0000-4000-8000-000000000001";
const SUR_ID = "5eed1000-0000-4000-8000-000000000002";
const OWNER_NORTE = "owner@demo-norte.example.test";
const PLAZA = "5eed4100-0000-4000-8000-000000000004";

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

async function accessible(page: Page, label: string) {
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

/** The home's sections, in the order the page shows them. */
function sectionsOf(page: string): string[] {
  return [...page.matchAll(/data-section="([a-z]+)"/gu)].map((match) => match[1] ?? "");
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

async function visibleTitles(page: Page): Promise<string[]> {
  return page.locator(".portal-card-title:visible").allInnerTexts();
}

describe("home by sections, categories and bottom bar (ADR-062)", () => {
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

  it("each municipality arranges its home; without a home of its own, the default", async () => {
    const sur = await html(SUR);
    expect(sectionsOf(sur)).toEqual(["figures", "events", "destinations", "tours", "assistant"]);
    // Its own figure first, then what the portal counts (other suites of the same job may
    // publish more places in Demo Sur: the count is read from the database).
    const [published] = await db<{ count: number }[]>`
      select count(*)::int as count from public.content_items
      where tenant_id = ${SUR_ID} and kind = 'destination' and published_revision_id is not null`;
    const figures = [
      ...sur.matchAll(
        /home-figure-value">([^<]+)<\/span><span class="home-figure-label">([^<]+)</gu,
      ),
    ].map((match) => [match[1], match[2]]);
    expect(figures[0]).toEqual(["4.100 m", "Altura de la laguna sobre el mar"]);
    expect(figures[1]).toEqual([
      String(published?.count),
      published?.count === 1 ? "Lugar para visitar" : "Lugares para visitar",
    ]);
    expect(figures.length).toBeLessThanOrEqual(4);
    expect(sur).toMatch(/data-variant="featured"/u);
    expect(sur).toMatch(/data-layout="cards"/u);

    const norte = await html(NORTE);
    expect(sectionsOf(norte)).toEqual([
      "figures",
      "destinations",
      "events",
      "tours",
      "passport",
      "assistant",
    ]);
    // Without destination photos, the cover is the text one.
    expect(norte).toMatch(/class="portal-hero" data-variant="text"/u);
    // Real badges only: the passport's stops say so; nothing invented (no ratings).
    expect(norte).toMatch(/Sello del pasaporte/u);
    expect(norte).not.toMatch(/★|estrellas/u);

    const page = await (
      await browser.newContext({ viewport: { width: 1280, height: 900 } })
    ).newPage();
    for (const origin of [NORTE, SUR]) {
      await page.goto(origin, { waitUntil: "networkidle" });
      await accessible(page, origin);
    }
    await page.context().close();
  });

  it("the destinations and the agenda filter by category in the browser", async () => {
    const page = await (
      await browser.newContext({ viewport: { width: 1280, height: 900 } })
    ).newPage();
    await page.goto(`${NORTE}/destinos`, { waitUntil: "networkidle" });
    const chips = page.getByRole("group", { name: "Categorías" });
    expect(await chips.getByRole("button").allInnerTexts()).toEqual([
      "Todos",
      "Miradores",
      "Plazas y centro",
    ]);
    expect(await visibleTitles(page)).toEqual(["Mirador del Valle", "Plaza principal"]);

    await chips.getByRole("button", { name: "Miradores" }).click();
    expect(
      await chips.getByRole("button", { name: "Miradores" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(await visibleTitles(page)).toEqual(["Mirador del Valle"]);
    expect(new URL(page.url()).searchParams.get("categoria")).toBe("miradores");
    await page.getByRole("status").filter({ hasText: "1 de 2 lugares" }).waitFor();
    await accessible(page, "/destinos?categoria=miradores");

    // The address keeps the filter (a filtered list can be shared).
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(
      () => document.querySelectorAll(".portal-card-title").length === 1,
      undefined,
      { timeout: 5_000 },
    );
    await chips.getByRole("button", { name: "Todos" }).click();
    expect(await visibleTitles(page)).toHaveLength(2);
    expect(new URL(page.url()).search).toBe("");

    // The agenda: the event's category, on its card and as a filter.
    await page.goto(`${NORTE}/agenda`, { waitUntil: "networkidle" });
    expect(await chips.getByRole("button").allInnerTexts()).toEqual(["Todos", "Ferias"]);
    await page.locator(".portal-event .portal-card-kicker", { hasText: "Ferias" }).waitFor();

    // Demo Sur's agenda has no category in use: no filters.
    await page.goto(`${SUR}/agenda`, { waitUntil: "networkidle" });
    expect(await page.getByRole("group", { name: "Categorías" }).count()).toBe(0);
    await page.context().close();
  });

  it("on a phone the sections are in a bottom bar, by the municipality's modules", async () => {
    const page = await (
      await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })
    ).newPage();
    await page.goto(`${NORTE}/destinos`, { waitUntil: "networkidle" });
    const bar = page.getByRole("navigation", { name: "Secciones" });
    // Demo Norte has every module and a circuit, but no tour published: no «Tours 360°».
    expect(await bar.getByRole("link").allInnerTexts()).toEqual([
      "Inicio",
      "Destinos",
      "Agenda",
      "Pasaporte",
      "Mapa",
    ]);
    await bar.locator('[aria-current="page"]', { hasText: "Destinos" }).waitFor();
    expect(await page.getByRole("navigation", { name: "Principal" }).isVisible()).toBe(false);
    // Fixed at the foot of the screen.
    const box = await bar.boundingBox();
    expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(844);

    await bar.getByRole("link", { name: "Agenda" }).click();
    await page.waitForURL(`${NORTE}/agenda`);
    await bar.locator('[aria-current="page"]', { hasText: "Agenda" }).waitFor();

    // On a computer the header has the links and there is no bar.
    await page.setViewportSize({ width: 1280, height: 900 });
    expect(await bar.isVisible()).toBe(false);
    expect(await page.getByRole("navigation", { name: "Principal" }).isVisible()).toBe(true);
    await page.context().close();
  });

  it("the owner manages the categories and the home in the panel", async () => {
    const page = await signIn(OWNER_NORTE);
    await page.goto(`${ADMIN}/o/demo-norte/categorias`);
    await page.getByRole("heading", { level: 1, name: "Categorías" }).waitFor();
    const destinations = page.locator("section", {
      has: page.getByRole("heading", { name: "Categorías de destinos" }),
    });
    await accessible(page, "/categorias");

    // A name already in the list is refused before anything changes.
    await destinations.getByRole("button", { name: "Agregar una categoría" }).click();
    await destinations.getByLabel("Nombre de la categoría 3").fill("miradores");
    await destinations.getByRole("button", { name: "Guardar" }).click();
    await destinations.getByText(/Hay dos categorías llamadas/u).waitFor();
    await destinations.getByLabel("Nombre de la categoría 3").fill("Museos");
    await destinations.getByRole("button", { name: "Guardar" }).click();
    await destinations.getByText("Guardado.", { exact: false }).waitFor();
    const names = await db<{ name: string }[]>`
      select name from public.content_categories
      where tenant_id = ${NORTE_ID} and kind = 'destination' and archived_at is null
      order by position`;
    expect(names.map((row) => row.name)).toEqual(["Miradores", "Plazas y centro", "Museos"]);
    const [audit] = await db<{ count: number }[]>`
      select count(*)::int as count from public.audit_events
      where tenant_id = ${NORTE_ID} and action = 'content.categories_saved'`;
    expect(audit?.count).toBeGreaterThan(0);

    // A destination's editor offers them and keeps the one it has.
    await page.goto(`${ADMIN}/o/demo-norte/destinos/${PLAZA}`);
    const category = page.getByLabel("Categoría");
    expect(await category.locator("option:checked").innerText()).toBe("Plazas y centro");
    expect(await category.locator("option").allInnerTexts()).toEqual([
      "Sin categoría",
      "Miradores",
      "Plazas y centro",
      "Museos",
    ]);

    // The home: events first and a figure of the municipality.
    await page.goto(`${ADMIN}/o/demo-norte/configuracion`);
    await page.getByRole("group", { name: "Inicio del portal" }).waitFor();
    await page.getByRole("button", { name: "Subir «Próximos eventos»" }).click();
    await page.locator("#home-figure-1-value").fill("1953");
    await page.locator("#home-figure-1-label").fill("Año de la primera feria");
    await accessible(page, "/configuracion");
    await page.getByRole("button", { name: "Publicar" }).click();
    await page.getByText(/Publicado\./u).waitFor({ timeout: 20_000 });
    const changed = await until(NORTE, (body) => body.includes("Año de la primera feria"));
    expect(sectionsOf(changed).slice(0, 3)).toEqual(["figures", "events", "destinations"]);
    expect(changed).toMatch(/home-figure-value">1953</u);

    // Back to the seed's home and categories.
    await page.getByRole("button", { name: "Bajar «Próximos eventos»" }).click();
    await page.locator("#home-figure-1-value").fill("");
    await page.locator("#home-figure-1-label").fill("");
    await page.getByRole("button", { name: "Publicar" }).click();
    const restored = await until(NORTE, (body) => !body.includes("Año de la primera feria"));
    expect(sectionsOf(restored).slice(0, 3)).toEqual(["figures", "destinations", "events"]);
    await page.goto(`${ADMIN}/o/demo-norte/categorias`);
    await destinations.getByRole("button", { name: "Quitar «Museos»" }).click();
    await destinations.getByRole("button", { name: "Guardar" }).click();
    await destinations.getByText("Guardado.", { exact: false }).waitFor();
    await page.context().close();
  });
});
