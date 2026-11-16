/**
 * A · Paso 1.1 (ADR-069) in a real browser against the local stack:
 *
 * - the owner of Demo Sur creates a notice in «Avisos», about one of its places, with an end in
 *   two days, and publishes it; its state in the list is «Vigente»;
 * - visitors see it in the strip of every page of Demo Sur, in /avisos with its anchor and its
 *   validity in the municipality's time, and in «Para tu visita» of its place; Demo Norte does
 *   not;
 * - a notice that starts in three days is not shown yet;
 * - with the browser's clock past its end, a cached page drops it (strip and /avisos);
 * - retiring it from the panel takes it off the portal at once;
 * - /avisos is checked with axe and for overflow at 390 and 1280 px, and is not indexed.
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
const PORTAL = `http://demo-sur.localhost:${PORT}`;
const NORTE = `http://demo-norte.localhost:${PORT}`;
const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SUR = "5eed1000-0000-4000-8000-000000000002";
const OWNER_SUR = "5eed0000-0000-4000-8000-000000000002";
const OWNER_EMAIL = "owner@demo-sur.example.test";
const STAMP = Date.now().toString(36);
const TITLE = `Corte de agua ${STAMP}`;
const SCHEDULED = `Feria de la próxima semana ${STAMP}`;

const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
let browser: Browser;
let timezone = "America/La_Paz";
let place: { id: string; slug: string; title: string };

/** A local minute of the municipality, `YYYY-MM-DDTHH:MM`, some hours from now. */
function localMinute(hoursFromNow: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(Date.now() + hoursFromNow * 3_600_000));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

/** One request to the portal as a visitor would send it. */
function visitStatus(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port: PORT, path, headers: { host: `demo-sur.localhost:${PORT}` } },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

/** A notice published as the owner of Demo Sur, through the same RPCs as the panel. */
async function publishedNotice(title: string, from: string, until: string): Promise<string> {
  return db.begin(async (sql) => {
    await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: OWNER_SUR, role: "authenticated", aal: "aal2" })}, true)`;
    await sql`set local role authenticated`;
    const [created] = await sql<{ content_id: string }[]>`
      select content_id from public.create_content_item(${SUR}, 'notice', ${`aviso-${STAMP}-programado`}, ${title})`;
    if (!created) throw new Error("not created");
    const document = {
      title,
      summary: "Todavía no empieza.",
      body: [],
      validity: { from, until },
      placeId: null,
    };
    await sql`select * from public.save_content_draft(${SUR}, ${created.content_id}, ${sql.json(document)}, 1)`;
    await sql`select * from public.publish_content(${SUR}, ${created.content_id}, 2)`;
    return created.content_id;
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

const strip = (page: Page) => page.getByRole("region", { name: "Avisos del municipio" });

describe("notices of the municipality (ADR-069)", () => {
  beforeAll(async () => {
    const [tenant] = await db<{ timezone: string }[]>`
      select timezone from public.tenants where id = ${SUR}`;
    if (tenant) timezone = tenant.timezone;
    // A destination of Demo Sur that visitors can open.
    const [destination] = await db<{ id: string; slug: string; title: string }[]>`
      select ci.id, ci.slug, r.title
        from public.content_items ci
        join public.content_revisions r on r.id = ci.published_revision_id
       where ci.tenant_id = ${SUR} and ci.kind = 'destination'
       order by ci.created_at limit 1`;
    if (!destination) throw new Error("Demo Sur has no published destination");
    place = destination;
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
          select id from public.content_items
           where tenant_id = ${SUR} and kind = 'notice' and slug like ${`%${STAMP}%`}
             and published_revision_id is not null`;
        for (const notice of left) {
          await sql`select public.retire_content(${SUR}, ${notice.id})`;
        }
      })
      .catch(() => undefined);
    await browser?.close();
    await db.end({ timeout: 5 });
  });

  it("publishes a notice that visitors see everywhere until it ends or is retired", async () => {
    await publishedNotice(SCHEDULED, localMinute(72), localMinute(24 * 10));

    const page = await ownerPage();
    await page.goto(`${ADMIN}/o/demo-sur/avisos?nuevo`);
    await page.getByLabel("Título").fill(TITLE);
    await page.getByRole("button", { name: "Crear" }).click();
    await page.waitForURL(/\/o\/demo-sur\/avisos\/[0-9a-f-]{36}$/u, { timeout: 15_000 });
    await page.getByLabel("Texto del aviso").fill("No habrá agua en el centro por obras.");
    await page.getByLabel("Hasta").fill(localMinute(48));
    await page.getByLabel("¿Es sobre un lugar o un evento?").selectOption(place.id);
    await page.getByRole("button", { name: "Publicar" }).click();
    await page
      .getByText("Publicado. Se ve en el portal mientras esté vigente.")
      .waitFor({ timeout: 15_000 });

    await page.goto(`${ADMIN}/o/demo-sur/avisos`);
    const row = page.getByRole("row", { name: new RegExp(TITLE) });
    await expect(row.innerText()).resolves.toContain("Vigente");
    await expect(
      page.getByRole("row", { name: new RegExp(SCHEDULED) }).innerText(),
    ).resolves.toContain("Programado");

    // Visitors: the strip on every page, /avisos and the place's page.
    const visitor = await visitorPage();
    for (const path of ["/", "/destinos", "/agenda"]) {
      await visitor.goto(`${PORTAL}${path}`);
      await expect(strip(visitor).innerText()).resolves.toContain(TITLE);
      await expect(strip(visitor).innerText()).resolves.not.toContain(SCHEDULED);
    }
    await strip(visitor)
      .getByRole("link", { name: `Ver el aviso «${TITLE}»` })
      .click();
    await visitor.waitForURL(/\/avisos#corte-de-agua-/u);
    const article = visitor.locator(".portal-notice-list article", {
      has: visitor.getByRole("heading", { name: TITLE }),
    });
    await expect(article.innerText()).resolves.toMatch(
      /Hasta el \d+ de \w+ de \d{4}, \d{2}:\d{2}/u,
    );
    await expect(
      article.getByRole("link", { name: place.title }).getAttribute("href"),
    ).resolves.toBe(`/destinos/${place.slug}`);
    await expect(visitor.getByRole("heading", { name: SCHEDULED }).count()).resolves.toBe(0);
    await expect(
      visitor.locator('meta[name="robots"]').first().getAttribute("content"),
    ).resolves.toContain("noindex");
    await accessible(visitor, "/avisos");

    await visitor.goto(`${PORTAL}/destinos/${place.slug}`);
    const visit = visitor.getByRole("complementary", { name: "Para tu visita" });
    await expect(visit.innerText()).resolves.toContain(TITLE);
    await accessible(visitor, "a place with a notice");

    // Demo Norte has its own notices, never Demo Sur's.
    await visitor.goto(`${NORTE}/`);
    await expect(visitor.getByText(TITLE).count()).resolves.toBe(0);
    await expect((await visitor.goto(`${NORTE}/avisos`))?.status()).toBe(200);
    await expect(visitor.getByText(TITLE).count()).resolves.toBe(0);

    // The page is cached: with the browser's clock past the end, it drops the notice.
    const later = await (
      await browser.newContext({ viewport: { width: 1280, height: 900 } })
    ).newPage();
    await later.clock.install({ time: new Date(Date.now() + 3 * 86_400_000) });
    await later.goto(`${PORTAL}/avisos`);
    await later.getByText("No hay avisos vigentes.").waitFor({ timeout: 15_000 });
    await expect(later.getByRole("heading", { name: TITLE }).count()).resolves.toBe(0);
    await later.goto(`${PORTAL}/destinos`);
    await later.waitForLoadState("networkidle");
    await strip(later).waitFor({ state: "detached", timeout: 15_000 });

    // Retired from the panel: off the portal at once.
    await page.goto(`${ADMIN}/o/demo-sur/avisos`);
    await page.getByRole("link", { name: TITLE }).click();
    await page.getByRole("button", { name: "Retirar ahora" }).click();
    const confirm = page.getByRole("button", {
      name: "Confirmar: retirar el aviso del portal y del asistente",
    });
    await confirm.click();
    // Retired, the editor reloads: no confirmation and nothing left to retire.
    await confirm.waitFor({ state: "detached", timeout: 15_000 });
    await page.waitForLoadState("load");
    await expect(page.getByRole("button", { name: "Retirar ahora" }).count()).resolves.toBe(0);
    expect(await visitStatus("/avisos")).toBe(200);
    for (const path of ["/avisos", `/destinos/${place.slug}`]) {
      // The pages were marked stale on retiring: the next visits get them fresh.
      let shown = 1;
      for (let attempt = 0; attempt < 10 && shown > 0; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
        await visitor.goto(`${PORTAL}${path}`);
        shown = await visitor.getByText(TITLE).count();
      }
      expect(shown, path).toBe(0);
    }
  });
});
