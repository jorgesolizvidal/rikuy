/**
 * C3 · Paso 7 (ADR-066) in a real browser against the local stack: the municipality's panel
 * with Rikuy's design system.
 *
 * - on a PC, the menu stays on the left with its groups, only the municipality's modules and
 *   what the role can open, and the page's section marked (also on a destination's editor);
 * - the home's summary has real numbers: the same the statistics, the questions, the Copilot's
 *   review and the list of destinations show, each with its link;
 * - on a phone the menu opens with «Menú», closes on Escape (focus back on the button) and when
 *   a page is chosen; lists are cards, with each value's column name;
 * - a destination saved as a draft shows «Con cambios»; the editor's «Publicar / Guardar» bar
 *   stays in view while scrolling; a disabled button is grey, not the brand's color;
 * - the panel looks the same for every municipality (its colors are not the portal's);
 * - axe without critical or serious findings and no overflow at 390 and 1280 px.
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
const NORTE = "5eed1000-0000-4000-8000-000000000001";
const OWNER_NORTE = "owner@demo-norte.example.test";
const OWNER_SUR = "owner@demo-sur.example.test";
// Editor in Demo Norte, analyst in Demo Sur.
const EDITOR = "editor.ambos@example.test";

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
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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
      `${label}: axe at ${width} px`,
    ).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      `${label}: overflow at ${width} px`,
    ).toBe(false);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

const menu = (page: Page) => page.getByRole("navigation", { name: "Secciones" });

async function menuGroups(page: Page) {
  return menu(page)
    .locator(".panel-nav-group")
    .evaluateAll((groups) =>
      groups.map((group) => [
        group.querySelector(".panel-nav-title")?.textContent ?? null,
        [...group.querySelectorAll("a")].map((link) => link.textContent ?? ""),
      ]),
    );
}

async function current(page: Page) {
  return menu(page).locator('a[aria-current="page"]').allInnerTexts();
}

const tileNumber = (page: Page, label: string) =>
  page
    .locator(".summary-tile")
    .filter({ has: page.locator(".summary-label", { hasText: label }) })
    .locator(".summary-number")
    .innerText();

describe("the municipality's panel with the design system (ADR-066)", () => {
  beforeAll(async () => {
    browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
    });
  });

  afterAll(async () => {
    await browser?.close();
    await db.end({ timeout: 5 });
  });

  it("on a PC: the grouped menu and a summary with the same numbers as each page", async () => {
    const { context, page } = await signedIn(OWNER_NORTE);
    await page.goto(`${ADMIN}/o/demo-norte`);
    await page.getByRole("heading", { level: 1, name: "Municipio Demo Norte" }).waitFor();
    // Panel pages are dynamic: the menu does not prefetch them (each would be rendered).
    const prefetched: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("_rsc=")) prefetched.push(request.url());
    });
    await page.reload({ waitUntil: "networkidle" });
    expect(prefetched).toEqual([]);

    // The skip link is still the first Tab.
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(
      "Saltar al contenido",
    );

    expect(await menuGroups(page)).toEqual([
      [null, ["Inicio"]],
      [
        "Contenido",
        [
          "Destinos",
          "Agenda",
          "Categorías",
          "Tours 360°",
          "Panoramas 360°",
          "Modelos 3D",
          "Copilot",
        ],
      ],
      ["Para visitantes", ["Pasaporte turístico", "Conocimiento del asistente"]],
      ["Resultados", ["Estadísticas", "Lo que preguntan los visitantes", "Informe mensual"]],
      ["Ajustes", ["Marca del portal", "Miembros", "Uso del plan"]],
    ]);
    expect(await current(page)).toEqual(["Inicio"]);
    expect(await page.getByRole("button", { name: "Cerrar sesión" }).count()).toBe(1);
    // The menu stays in view on a PC.
    expect(await page.getByRole("button", { name: "Menú" }).isVisible()).toBe(false);

    // The portal, in line, with its address.
    const portal = page.locator(".summary-tile").filter({ hasText: "Portal" });
    expect(await portal.locator(".status-pill").innerText()).toBe("En línea");
    expect(await portal.getByRole("link").getAttribute("href")).toBe(
      `http://demo-norte.localhost:${PORT}`,
    );
    await accessible(page, "home");

    // Each number is the one its page shows.
    const visits = await tileNumber(page, "Visitas");
    await page.getByRole("link", { name: "Ver las estadísticas" }).click();
    await page.waitForURL(/\/estadisticas\?periodo=7-dias$/u);
    expect(await page.locator(".stats-tiles .stats-tile-value").first().innerText()).toBe(visits);
    expect(await current(page)).toEqual(["Estadísticas"]);

    await page.goto(`${ADMIN}/o/demo-norte`);
    const questions = await tileNumber(page, "Preguntas sin respuesta");
    await page.getByRole("link", { name: "Ver qué preguntaron" }).click();
    await page.waitForURL(/\/preguntas\?periodo=7-dias$/u);
    expect(await page.locator(".stats-tile-value").first().innerText()).toBe(questions);

    await page.goto(`${ADMIN}/o/demo-norte`);
    const review = await tileNumber(page, "Revisión del Copilot");
    await page.getByRole("link", { name: "Ver la revisión" }).click();
    await page.waitForURL(/\/copilot$/u);
    const reviewed = await page
      .locator("section[aria-labelledby=revision] tbody tr td:first-child a")
      .evaluateAll((links) => [...new Set(links.map((link) => link.getAttribute("href")))]);
    expect(String(reviewed.length)).toBe(review);

    await page.goto(`${ADMIN}/o/demo-norte`);
    const content = await page
      .locator(".summary-tile")
      .filter({ has: page.locator(".summary-label", { hasText: /^Contenido$/u }) })
      .locator(".summary-detail")
      .first()
      .innerText();
    await page.getByRole("link", { name: "Ir a la lista de destinos" }).click();
    await page.waitForURL(/\/destinos$/u);
    const statuses = await page
      .locator(".data-table .status-pill")
      .evaluateAll((pills) => pills.map((pill) => pill.getAttribute("data-status")));
    const published = statuses.filter((status) => status !== "draft").length;
    const drafts = statuses.filter((status) => status === "draft").length;
    expect(content).toContain(`${published} destino${published === 1 ? "" : "s"} publicado`);
    if (drafts > 0) expect(content).toContain(`${drafts} borrador`);

    // A destination's editor belongs to «Destinos».
    await page.locator(".data-table a").first().click();
    await page.waitForURL(/\/destinos\/[0-9a-f-]{36}$/u);
    expect(await current(page)).toEqual(["Destinos"]);
    await context.close();
  });

  it("an editor's menu: without members; a menu read for every page", async () => {
    const { context, page } = await signedIn(EDITOR);
    await page.goto(`${ADMIN}/o/demo-norte/agenda`);
    const items = (await menuGroups(page)).flatMap(([, links]) => links as string[]);
    expect(items).not.toContain("Miembros");
    expect(items).not.toContain("Contenido de muestra");
    expect(items).toContain("Agenda");
    expect(await current(page)).toEqual(["Agenda"]);
    // Every entry opens (none answers 404 for this role).
    for (const href of await menu(page)
      .getByRole("link")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""))) {
      const response = await page.goto(`${ADMIN}${href}`);
      expect(response?.status(), href).toBe(200);
    }
    await context.close();
  });

  it("on a phone: «Menú», lists as cards, «Con cambios», the editor's bar and disabled buttons", async () => {
    const { context, page } = await signedIn(OWNER_NORTE);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${ADMIN}/o/demo-norte/destinos`);
    const toggle = page.getByRole("button", { name: "Menú" });
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    expect(await menu(page).getByRole("link").count()).toBe(0);
    await toggle.click();
    expect(await toggle.getAttribute("aria-expanded")).toBe("true");
    expect(await current(page)).toEqual(["Destinos"]);
    await accessible(page, "menu open");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press("Escape");
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Menú");
    await toggle.click();
    await menu(page).getByRole("link", { name: "Agenda", exact: true }).click();
    await page.waitForURL(/\/agenda$/u);
    await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("false");

    // Lists are cards: one per row, each value with its column's name.
    await page.goto(`${ADMIN}/o/demo-norte/destinos`);
    const row = page.locator(".data-table-cards tbody tr").first();
    expect(await row.evaluate((element) => getComputedStyle(element).display)).toBe("grid");
    expect(
      await row
        .locator("td[data-label]")
        .first()
        .evaluate((cell) => getComputedStyle(cell, "::before").content),
    ).toBe('"Estado"');

    // A disabled button is grey, not the panel's color.
    const create = page.getByRole("button", { name: "Crear destino" });
    expect(await create.isDisabled()).toBe(true);
    const disabled = await create.evaluate((button) => {
      const style = getComputedStyle(button);
      return { background: style.backgroundColor, cursor: style.cursor };
    });
    expect(disabled.cursor).toBe("not-allowed");
    expect(disabled.background).not.toBe("rgb(30, 91, 71)");

    // A draft over a published destination: «Con cambios».
    const [mirador] = await db<{ id: string }[]>`
      select id from public.content_items
      where tenant_id = ${NORTE} and slug = 'mirador-del-valle'`;
    await page.goto(`${ADMIN}/o/demo-norte/destinos/${mirador?.id ?? ""}`);
    const summary = page.getByLabel("Resumen", { exact: true });
    const before = await summary.inputValue();
    await summary.fill(`${before} Con calma.`);
    // The bar stays in view at the top of a long editor.
    await page.evaluate(() => window.scrollTo(0, 0));
    const bar = page.locator(".sticky-actions");
    const box = await bar.boundingBox();
    expect(box && box.y + box.height).toBeLessThanOrEqual(844 + 1);
    expect(box && box.y).toBeGreaterThan(600);
    await bar.getByRole("button", { name: "Guardar borrador" }).click();
    await page.getByText(/Borrador guardado/u).waitFor();
    await page.goto(`${ADMIN}/o/demo-norte/destinos`);
    const changed = page
      .locator(".data-table-cards tbody tr")
      .filter({ hasText: "Mirador del Valle" })
      .locator(".status-pill");
    expect(await changed.innerText()).toBe("Con cambios");
    expect(await changed.getAttribute("data-status")).toBe("changed");
    await accessible(page, "destinations with a draft");

    // Back to what is published.
    await page.goto(`${ADMIN}/o/demo-norte/destinos/${mirador?.id ?? ""}`);
    await page.getByRole("button", { name: "Descartar borrador y volver a lo publicado" }).click();
    await page.getByRole("button", { name: "Confirmar: descartar el borrador" }).click();
    await expect
      .poll(
        async () =>
          (
            await db<{ draft: string | null }[]>`
              select draft_revision_id as draft from public.content_items
              where id = ${mirador?.id ?? ""}`
          )[0]?.draft,
        { timeout: 15_000 },
      )
      .toBeNull();
    await context.close();
  });

  it("the panel looks the same for every municipality", async () => {
    const colors = async (email: string, slug: string) => {
      const { context, page } = await signedIn(email);
      await page.goto(`${ADMIN}/o/${slug}`);
      const read = await page.evaluate(() => {
        const admin = getComputedStyle(document.querySelector(".admin") as Element);
        const button = getComputedStyle(document.querySelector(".panel-nav-name") as Element);
        return {
          background: admin.backgroundColor,
          accent: admin.getPropertyValue("--accent").trim(),
          font: button.fontFamily,
        };
      });
      await context.close();
      return read;
    };
    const north = await colors(OWNER_NORTE, "demo-norte");
    const south = await colors(OWNER_SUR, "demo-sur");
    expect(north).toEqual(south);
    expect(north.font).toContain("Rikuy Editorial");
  });
});
