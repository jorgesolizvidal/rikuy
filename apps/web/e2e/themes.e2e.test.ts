/**
 * C3 · Paso 2 (ADR-061) in a real browser against the local stack: portal themes.
 *
 * - the same build serves Demo Norte in «editorial» and Demo Sur in «immersive»: different
 *   fonts (each portal downloads only its own), cards (photo on top vs. text over the photo),
 *   footer, buttons and event list; both accessible and without overflow at 390 and 1280 px;
 * - the owner of Demo Sur sees «Tema del portal» with a live preview: «Inmersivo» has only a
 *   dark background; switching to «Editorial» on light and publishing changes the portal at
 *   the next visit, and switching back restores it;
 * - a theme the database does not know, or an immersive theme on light, is rejected.
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
const SUR_ID = "5eed1000-0000-4000-8000-000000000002";
const OWNER_SUR = "owner@demo-sur.example.test";
const JAKARTA = /\/vendor\/fonts\/plus-jakarta-sans\/[\d.]+\/[a-z-]+\.woff2$/u;
const BRICOLAGE = /\/vendor\/fonts\/bricolage-grotesque\/[\d.]+\/[a-z-]+\.woff2$/u;

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

interface Look {
  theme: string | null;
  titleFont: string;
  bodyFont: string;
  /** The card's title sits over its photo (immersive) or below it (editorial). */
  titleOverPhoto: boolean;
  footerIsBrand: boolean;
  fonts: string[];
}

/** Opens a portal home and reads what makes its theme visible. */
async function look(origin: string): Promise<Look> {
  const page = await (
    await browser.newContext({ viewport: { width: 1280, height: 900 } })
  ).newPage();
  const fonts: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith(".woff2")) fonts.push(new URL(request.url()).pathname);
  });
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const result = await page.evaluate(() => {
    const portal = document.querySelector(".portal") as HTMLElement;
    const style = (selector: string) =>
      getComputedStyle(document.querySelector(selector) as Element);
    const media = (document.querySelector(".portal-card-media") as Element).getBoundingClientRect();
    const title = (document.querySelector(".portal-card-title") as Element).getBoundingClientRect();
    return {
      theme: portal.dataset.theme ?? null,
      titleFont: style(".portal-hero h1").fontFamily,
      bodyFont: style(".portal-intro").fontFamily,
      titleOverPhoto: title.bottom <= media.bottom,
      // The monogram's square is the brand color.
      footerIsBrand:
        style(".portal-footer").backgroundColor === style(".portal-mark").backgroundColor,
    };
  });
  await page.context().close();
  return { ...result, fonts };
}

/** The published theme of Demo Sur, once it equals `expected` (publishing takes a moment). */
async function publishedTheme(expected: Record<string, string>) {
  const deadline = Date.now() + 20_000;
  let theme: unknown = null;
  while (Date.now() < deadline) {
    const [row] = await db<{ theme: Record<string, string> }[]>`
      select v.branding -> 'theme' as theme from public.tenant_config_versions v
      join public.tenants t on t.active_config_id = v.id where t.id = ${SUR_ID}`;
    theme = row?.theme ?? null;
    if (JSON.stringify(theme) === JSON.stringify(expected)) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return theme;
}

describe("portal themes (ADR-061)", () => {
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

  it("the same content looks like two different sites, each loading only its font", async () => {
    const norte = await look(NORTE);
    expect(norte.theme).toBe("editorial");
    expect(norte.titleFont).toMatch(/^"Rikuy Editorial"/u);
    // Reading text: the same file as a family that never swaps after the first paint.
    expect(norte.bodyFont).toMatch(/^"Rikuy Editorial Text"/u);
    expect(norte.titleOverPhoto).toBe(false);
    expect(norte.footerIsBrand).toBe(true);
    expect(norte.fonts.length).toBeGreaterThan(0);
    expect(
      norte.fonts.every((font) => JAKARTA.test(font)),
      norte.fonts.join(),
    ).toBe(true);

    const sur = await look(SUR);
    expect(sur.theme).toBe("immersive");
    expect(sur.titleFont).toMatch(/^"Rikuy Inmersivo"/u);
    // Reading text keeps the system font: only titles use the display face.
    expect(sur.bodyFont).not.toMatch(/Rikuy/u);
    expect(sur.titleOverPhoto).toBe(true);
    expect(sur.footerIsBrand).toBe(false);
    expect(sur.fonts.length).toBeGreaterThan(0);
    expect(
      sur.fonts.every((font) => BRICOLAGE.test(font)),
      sur.fonts.join(),
    ).toBe(true);

    // Each page preloads only its theme's file.
    const norteHtml = await html(NORTE);
    expect(norteHtml).toMatch(/<link rel="preload" href="[^"]*plus-jakarta-sans[^"]*" as="font"/u);
    expect(norteHtml).not.toMatch(/bricolage-grotesque/u);
    const surHtml = await html(SUR);
    expect(surHtml).toMatch(/<link rel="preload" href="[^"]*bricolage-grotesque[^"]*" as="font"/u);
    expect(surHtml).not.toMatch(/plus-jakarta-sans/u);
  });

  it("both themes are accessible on every main page, and buttons change shape", async () => {
    const page = await (
      await browser.newContext({ viewport: { width: 1280, height: 900 } })
    ).newPage();
    const radii: Record<string, string> = {};
    for (const [origin, place] of [
      [NORTE, "/destinos/mirador-del-valle"],
      [SUR, "/destinos/laguna-espejo"],
    ] as const) {
      for (const path of ["/", "/destinos", "/agenda", place]) {
        await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
        await accessible(page, `${origin}${path}`);
      }
      radii[origin] = await page
        .locator(".portal-actions .portal-button")
        .first()
        .evaluate((element) => getComputedStyle(element).borderTopLeftRadius);
    }
    expect(Number.parseFloat(radii[NORTE] ?? "0")).toBeGreaterThan(100); // a pill
    expect(Number.parseFloat(radii[SUR] ?? "0")).toBeLessThan(10); // square-ish
    await page.context().close();
  });

  it("the owner changes the theme with a preview, and the portal follows", async () => {
    const page = await signIn(OWNER_SUR);
    await page.goto(`${ADMIN}/o/demo-sur/configuracion`);
    await page.getByRole("heading", { level: 1, name: "Marca del portal" }).waitFor();
    const group = page.getByRole("group", { name: "Tema del portal" });
    const preview = page.locator(".preview-portal");

    expect(await group.getByRole("radio", { name: /Inmersivo/u }).isChecked()).toBe(true);
    expect(await preview.getAttribute("data-theme")).toBe("immersive");
    // Immersive has only a dark background.
    expect(await page.getByRole("radio", { name: /^Claro/u }).isDisabled()).toBe(true);
    await accessible(page, "/configuracion");

    await group.getByRole("radio", { name: /Editorial/u }).check();
    expect(await preview.getAttribute("data-theme")).toBe("editorial");
    await page.getByRole("radio", { name: /^Claro/u }).check();
    // The light orange of Demo Sur does not read on ivory: the preview says so.
    await page.getByText(/Color principal sobre el fondo: [\d,]+:1, insuficiente/u).waitFor();
    await page.getByLabel("Color principal", { exact: true }).fill("#14532d");
    await page.getByLabel("Color de acento", { exact: true }).fill("#b45309");
    await page.getByText(/Color principal sobre el fondo: [\d,]+:1, se lee bien/u).waitFor();
    expect(await preview.getAttribute("data-mode")).toBe("light");

    await page.getByRole("button", { name: "Publicar" }).click();
    const editorial = { style: "editorial", mode: "light", brand: "#14532d", accent: "#b45309" };
    expect(await publishedTheme(editorial)).toEqual(editorial);
    await page.getByText(/Publicado\./u).waitFor({ timeout: 20_000 });
    const changed = await html(SUR);
    expect(changed).toMatch(/data-theme="editorial"/u);
    expect(changed).toMatch(/data-mode="light"/u);

    // Back to the seed's look, from the same page.
    await group.getByRole("radio", { name: /Inmersivo/u }).check();
    expect(await page.getByRole("radio", { name: /^Oscuro/u }).isChecked()).toBe(true);
    await page.getByLabel("Color principal", { exact: true }).fill("#f0a868");
    await page.getByLabel("Color de acento", { exact: true }).fill("#7fb7d9");
    await page.getByRole("button", { name: "Publicar" }).click();
    const seed = { style: "immersive", mode: "dark", brand: "#f0a868", accent: "#7fb7d9" };
    expect(await publishedTheme(seed)).toEqual(seed);
    const restored = await html(SUR);
    expect(restored).toMatch(/data-theme="immersive"/u);
    expect(restored).toMatch(/--brand:#f0a868/u);
    await page.context().close();
  });

  it("the database accepts only the two themes, immersive only on dark", async () => {
    const theme = (value: object) =>
      db<{ ok: boolean }[]>`
        select private.is_valid_presentation(jsonb_set(v.branding, '{theme}', ${db.json(value as never)})) as ok
        from public.tenant_config_versions v join public.tenants t on t.active_config_id = v.id
        where t.id = ${SUR_ID}`.then((rows) => rows[0]?.ok);
    expect(
      await theme({ style: "immersive", mode: "dark", brand: "#f0a868", accent: "#7fb7d9" }),
    ).toBe(true);
    expect(
      await theme({ style: "immersive", mode: "light", brand: "#14532d", accent: "#b45309" }),
    ).toBe(false);
    expect(await theme({ style: "neon", mode: "dark", brand: "#f0a868", accent: "#7fb7d9" })).toBe(
      false,
    );
  });
});
