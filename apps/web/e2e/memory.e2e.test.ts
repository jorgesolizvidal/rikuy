/**
 * A · Paso 1.3 (ADR-069) in a real browser against the local stack:
 *
 * - the owner of Demo Sur creates a story in «Memoria de la comunidad», told by a neighbour
 *   about one of its destinations; without the person's consent it is not published; with it,
 *   it is, and the sealed revision and the audit keep the consent;
 * - visitors read it on /memoria with its anchor, who tells it and its place; the destination's
 *   page shows it in «Lo que cuenta la comunidad»; the header, the footer and the sitemap link
 *   /memoria; Demo Norte does not show it;
 * - told again as «anónimo», no name is kept and the portal says «Relato anónimo»;
 * - retiring it from the panel takes it off the portal;
 * - /memoria and the destination's page are checked with axe and for overflow at 390 and 1280 px.
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
const TITLE = `La noche de la helada ${STAMP}`;
const TELLER = "Doña Rosa Vargas";

const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
let browser: Browser;
let place: { id: string; slug: string; title: string };

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

/** The story on /memoria, once the portal shows it (its pages were marked stale on publishing). */
async function storyArticle(page: Page, text: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
    await page.goto(`${PORTAL}/memoria`);
    const article = page.getByRole("article", { name: TITLE });
    if ((await article.count()) > 0 && (await article.innerText()).includes(text)) break;
  }
  return page.getByRole("article", { name: TITLE });
}

describe("the community's memory (ADR-069)", () => {
  beforeAll(async () => {
    // A published destination of Demo Sur that the story is about.
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
          select ci.id from public.content_items ci
            join public.content_revisions r on r.id = ci.published_revision_id
           where ci.tenant_id = ${SUR} and ci.kind = 'story' and r.title = ${TITLE}`;
        for (const story of left) {
          await sql`select public.retire_content(${SUR}, ${story.id})`;
        }
      })
      .catch(() => undefined);
    await browser?.close();
    await db.end({ timeout: 5 });
  });

  it("publishes a story with the person's consent, always attributed", async () => {
    const page = await ownerPage();
    await page.goto(`${ADMIN}/o/demo-sur`);
    await page.getByRole("link", { name: "Memoria de la comunidad" }).first().click();
    await page.waitForURL(/\/o\/demo-sur\/memoria/u);
    await page.goto(`${ADMIN}/o/demo-sur/memoria?nuevo`);
    await page.getByLabel("Título").fill(TITLE);
    await page.getByRole("button", { name: "Crear" }).click();
    await page.waitForURL(/\/o\/demo-sur\/memoria\/[0-9a-f-]{36}$/u, { timeout: 15_000 });
    const contentId = page.url().split("/").at(-1) ?? "";

    await page.getByLabel("Resumen").fill("Cómo se salvó la cosecha del 63.");
    await page
      .getByLabel("El relato", { exact: true })
      .fill("Mi abuelo encendió fogatas toda la noche alrededor de la plaza.");
    await page.getByLabel("Nombre", { exact: true }).fill(TELLER);
    await page.getByLabel("Comunidad o relación con el lugar").fill("Vecina de la plaza");
    await page.getByLabel("¿Sobre qué lugar?").selectOption(place.id);
    // Without the person's consent it is not published.
    await page.getByRole("button", { name: "Publicar" }).click();
    await page.getByText("Sin el permiso de la persona el relato no se publica.").waitFor({
      timeout: 15_000,
    });
    await page.getByLabel("La persona aceptó que se publique su relato").check();
    await page.getByRole("button", { name: "Publicar" }).click();
    await page
      .getByText("Publicado. Ya se ve en la página «Memoria» del portal.")
      .waitFor({ timeout: 15_000 });

    // The sealed revision and the audit keep the consent.
    const [sealed] = await db<{ consent: boolean | null; author: string | null }[]>`
      select r.story_consent as consent, r.story_author as author
        from public.content_items i join public.content_revisions r on r.id = i.published_revision_id
       where i.id = ${contentId}`;
    expect(sealed).toEqual({ consent: true, author: TELLER });
    const [audit] = await db<{ diff: { consent?: boolean; kind?: string } }[]>`
      select diff from public.audit_events
       where action = 'content.published' and entity_id = ${contentId}
       order by occurred_at desc limit 1`;
    expect(audit?.diff).toMatchObject({ kind: "story", consent: true });

    await page.goto(`${ADMIN}/o/demo-sur/memoria`);
    const row = page.getByRole("row", { name: new RegExp(TITLE) });
    await expect(row.innerText()).resolves.toContain(TELLER);
    await expect(row.innerText()).resolves.toContain("Publicado");

    // Visitors: /memoria with who tells it and its place.
    const visitor = await visitorPage();
    const article = await storyArticle(visitor, TELLER);
    const slug = await article.getAttribute("id");
    expect(slug).toMatch(/^la-noche-de-la-helada-/u);
    await expect(article.innerText()).resolves.toContain(`Relato de ${TELLER}`);
    await expect(article.innerText()).resolves.toContain("Vecina de la plaza");
    await expect(article.innerText()).resolves.toContain("Mi abuelo encendió fogatas");
    await expect(
      article.getByRole("link", { name: place.title }).getAttribute("href"),
    ).resolves.toBe(`/destinos/${place.slug}`);
    await expect(
      visitor
        .getByRole("navigation", { name: "Principal" })
        .getByRole("link", { name: "Memoria" })
        .count(),
    ).resolves.toBe(1);
    await expect(
      visitor
        .getByRole("navigation", { name: "Para tu visita" })
        .getByRole("link", { name: /^Memoria de la comunidad/u })
        .getAttribute("href"),
    ).resolves.toBe("/memoria");
    await accessible(visitor, "/memoria");

    const sitemap = await (await fetch(`${PORTAL}/sitemap.xml`)).text();
    expect(sitemap).toContain("/memoria</loc>");

    // The destination's page: «Lo que cuenta la comunidad».
    await visitor.goto(`${PORTAL}/destinos/${place.slug}`);
    const section = visitor.getByRole("region", { name: "Lo que cuenta la comunidad" });
    await expect(section.innerText()).resolves.toContain(`Relato de ${TELLER}`);
    await expect(section.getByRole("link", { name: TITLE }).getAttribute("href")).resolves.toBe(
      `/memoria#${String(slug)}`,
    );
    await accessible(visitor, "a destination with a story");

    // Demo Norte has its own memory, never Demo Sur's.
    await visitor.goto(`${NORTE}/memoria`);
    await expect(visitor.getByText(TITLE).count()).resolves.toBe(0);

    // Told again as «anónimo»: no name is kept, the portal says so.
    await page.getByRole("link", { name: TITLE }).click();
    await page.getByLabel("Prefiere que sea anónimo").check();
    await expect(page.getByLabel("Nombre", { exact: true }).count()).resolves.toBe(0);
    await page.getByRole("button", { name: "Publicar" }).click();
    await page
      .getByText("Publicado. Ya se ve en la página «Memoria» del portal.")
      .waitFor({ timeout: 15_000 });
    const [anonymous] = await db<{ anonymous: boolean | null; author: string | null }[]>`
      select r.story_anonymous as anonymous, r.story_author as author
        from public.content_items i join public.content_revisions r on r.id = i.published_revision_id
       where i.id = ${contentId}`;
    expect(anonymous).toEqual({ anonymous: true, author: null });
    const told = await storyArticle(visitor, "Relato anónimo");
    await expect(told.innerText()).resolves.toContain("Relato anónimo");
    await expect(told.innerText()).resolves.not.toContain(TELLER);

    // Retired from the panel (the person asked): off the portal.
    await page.getByRole("button", { name: "Retirar (la persona lo pidió)" }).click();
    const confirm = page.getByRole("button", {
      name: "Confirmar: retirar el relato del portal y del asistente",
    });
    await confirm.click();
    await confirm.waitFor({ state: "detached", timeout: 15_000 });
    let shown = 1;
    for (let attempt = 0; attempt < 10 && shown > 0; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
      await visitor.goto(`${PORTAL}/memoria`);
      shown = await visitor.getByText(TITLE).count();
    }
    expect(shown).toBe(0);
  });
});
