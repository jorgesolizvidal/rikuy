/**
 * C1 · Paso 4 (ADR-054) in a real browser against the local stack and the simulated model:
 * «Recomendaciones del Copilot» in «Estadísticas».
 *
 * - a visitor's question nothing published answers carries a marker that makes the simulated
 *   model add a recommendation with a figure no fact has, and one citing a fact that does not
 *   exist: both are dropped, the rest are saved;
 * - the owner (with its second factor) generates them: each one shows the facts it rests on
 *   with their figures and links to the panel; nothing is published nor changed, no proposal
 *   is made, it is audited, and a second run replaces the first; the section is checked with
 *   axe and for overflow at 390 and 1280 px;
 * - an analyst (Demo Sur) generates them too, without «Proponer con el Copilot».
 */
import axe from "axe-core";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { passSecondFactor } from "./support/second-factor";

const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = Number(process.env.RIKUY_PORT ?? 3000);
const ADMIN = `http://app.localhost:${PORT}`;
const PORTAL = `http://demo-norte.localhost:${PORT}`;
const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const NORTE = "5eed1000-0000-4000-8000-000000000001";
const SUR = "5eed1000-0000-4000-8000-000000000002";
const OWNER_EMAIL = "owner@demo-norte.example.test";
// Editor in Demo Norte, analyst in Demo Sur.
const ANALYST_SUR_EMAIL = "editor.ambos@example.test";
const STAMP = Date.now()
  .toString(36)
  .replace(/\d/gu, (digit) => "abcdefghij"[Number(digit)] ?? "x");

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

/** Asks the open assistant and waits for its answer. */
async function ask(page: Page, question: string) {
  const before = await page.locator(".assistant-from-assistant").count();
  await page.getByLabel(/Tu pregunta para/u).fill(question);
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll(".assistant-from-assistant").length > count &&
      !document.querySelector(".assistant-typing"),
    before,
  );
}

interface Saved {
  id: string;
  items: number;
}

async function saved(tenant: string): Promise<Saved[]> {
  return db<Saved[]>`
    select id, jsonb_array_length(items) as items from public.copilot_recommendations
    where tenant_id = ${tenant}`;
}

/** What could be published or proposed: must not move. */
async function contentState(tenant: string): Promise<string> {
  const rows = await db<{ state: string }[]>`
    select coalesce(string_agg(i.id || ':' || coalesce(i.published_revision_id::text, '-') || ':' ||
             coalesce(i.draft_revision_id::text, '-'), ',' order by i.id), '') ||
           '|' || (select count(*) from public.copilot_proposals p where p.tenant_id = ${tenant}) as state
    from public.content_items i where i.tenant_id = ${tenant}`;
  return rows[0]?.state ?? "";
}

async function generate(page: Page) {
  await page.getByRole("button", { name: /Generar recomendaciones/u }).click();
  await page
    .getByText(/^Listo: \d+ recomendaci(?:ón|ones) nuevas?\.$/u)
    .waitFor({ timeout: 30_000 });
}

describe("«Recomendaciones del Copilot» (ADR-054)", () => {
  beforeAll(async () => {
    await db`delete from public.copilot_recommendations where tenant_id in (${NORTE}, ${SUR})`;
    // A clean hour for this visitor in Demo Norte (10 questions per hour, ADR-036).
    await db`
      delete from public.ai_executions where request_id in (
        select id from public.ai_requests where tenant_id = ${NORTE} and profile = 'assistant')`;
    await db`delete from public.ai_requests where tenant_id = ${NORTE} and profile = 'assistant'`;
    browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await db.end({ timeout: 5 });
  });

  it("rests every recommendation on the platform's figures and changes nothing", async () => {
    // A visitor asks something nothing published answers; the marker rides along as data.
    const visitor = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const portal = await visitor.newPage();
    await portal.goto(PORTAL);
    await portal.getByRole("button", { name: /hacer una pregunta/u }).click();
    await ask(portal, `¿Hay cajero ${STAMP}? [simular:no-sabe] [simular:cifra-inventada]`);
    await expect
      .poll(
        async () => {
          const [row] = await db<{ count: number }[]>`
          select count(*)::int as count from public.unanswered_questions
          where tenant_id = ${NORTE} and question_key like ${`%${STAMP}%`}`;
          return row?.count ?? 0;
        },
        { timeout: 10_000 },
      )
      .toBe(1);
    await visitor.close();

    const before = await contentState(NORTE);
    const { context, page } = await signedIn(OWNER_EMAIL);
    await page.goto(`${ADMIN}/o/demo-norte/copilot`);
    await page.getByRole("link", { name: /Recomendaciones del Copilot/u }).click();
    await page.waitForURL(/\/o\/demo-norte\/estadisticas#recomendaciones$/u);
    const section = page.locator("section", {
      has: page.getByRole("heading", { name: "Recomendaciones del Copilot" }),
    });
    await expect.poll(() => section.innerText()).toContain("Todavía no hay recomendaciones");

    await generate(page);
    const items = section.locator(".recommendation");
    // One per source of facts; the invented figure and the unknown fact were dropped.
    await expect.poll(() => items.count()).toBe(4);
    const text = await section.innerText();
    expect(text).not.toContain("98765");
    expect(text).not.toContain("un dato que no existe");
    expect(text).toMatch(/Generadas el .+ · visitas del .+ al .+/u);

    for (let index = 0; index < 4; index += 1) {
      const item = items.nth(index);
      const why = await item.locator("p").first().innerText();
      const facts = await item.locator(".recommendation-facts li").allInnerTexts();
      expect(facts.length, why).toBeGreaterThan(0);
      // Every figure of the recommendation is in the facts it shows.
      const known = new Set(facts.join(" ").match(/\d+(?:[.,]\d+)*/gu) ?? []);
      for (const figure of why.match(/\d+(?:[.,]\d+)*/gu) ?? [])
        expect(known, why).toContain(figure);
    }
    const questions = items.filter({ hasText: "no supo responder" });
    expect(await questions.count()).toBe(1);
    expect(await questions.locator(".recommendation-source").first().innerText()).toBe(
      "Preguntas sin respuesta",
    );
    const agenda = items.filter({ has: page.getByRole("link", { name: "Abrir la agenda" }) });
    expect(await agenda.getByRole("link", { name: "Abrir la agenda" }).getAttribute("href")).toBe(
      "/o/demo-norte/agenda",
    );

    await accessible(page);

    const first = await saved(NORTE);
    expect(first).toEqual([{ id: expect.any(String), items: 4 }]);
    // Nothing published, no draft touched, no proposal made.
    expect(await contentState(NORTE)).toBe(before);
    const [audit] = await db<{ count: number }[]>`
      select count(*)::int as count from public.audit_events
      where tenant_id = ${NORTE} and action = 'copilot.recommendations_generated'`;
    expect(audit?.count).toBeGreaterThanOrEqual(1);

    // A second run replaces the first.
    await generate(page);
    await expect.poll(async () => (await saved(NORTE))[0]?.id).not.toBe(first[0]?.id);
    expect((await saved(NORTE)).length).toBe(1);
    await context.close();
  });

  it("is for any member: an analyst generates them, without «Proponer»", async () => {
    const { context, page } = await signedIn(ANALYST_SUR_EMAIL);
    await page.goto(`${ADMIN}/o/demo-sur/estadisticas`);
    await generate(page);
    const section = page.locator("section", {
      has: page.getByRole("heading", { name: "Recomendaciones del Copilot" }),
    });
    await expect.poll(() => section.locator(".recommendation").count()).toBeGreaterThan(0);
    expect(await section.getByRole("link", { name: /^Proponer/u }).count()).toBe(0);
    expect(await section.getByRole("link", { name: "Abrir la agenda" }).count()).toBeGreaterThan(0);
    expect((await saved(SUR)).length).toBe(1);
    await context.close();
  });
});
