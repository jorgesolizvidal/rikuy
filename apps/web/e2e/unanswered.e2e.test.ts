/**
 * C1 · Paso 3 (ADR-053) in a real browser against the local stack and the simulated model:
 * «Lo que preguntan los visitantes».
 *
 * - a visitor asks Demo Norte's assistant something nothing published answers, from a place's
 *   page and again from the home page with other case and accents: both are kept, with the
 *   page and the place; one with an email and a phone is kept masked; nothing about the
 *   visitor is kept;
 * - a greeting and a question left without answer by a provider failure are not kept;
 * - the owner (with its second factor) finds them grouped in the panel, with how many times,
 *   the pages they were asked on and a link that tries the question in «Conocimiento del
 *   asistente»; the page is checked with axe and for overflow at 390 and 1280 px;
 * - an editor sees them too; the owner of another municipality gets a 404.
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
const OWNER_EMAIL = "owner@demo-norte.example.test";
const OWNER_SUR_EMAIL = "owner@demo-sur.example.test";
// Editor in Demo Norte, analyst in Demo Sur.
const EDITOR_EMAIL = "editor.ambos@example.test";
// Letters only, so the run's word never looks like a long number to mask.
const STAMP = Date.now()
  .toString(36)
  .replace(/\d/gu, (digit) => "abcdefghij"[Number(digit)] ?? "x");
const PAGE = `${ADMIN}/o/demo-norte/preguntas`;
/** The grouped question, as the panel shows it (case-sensitive: the other one has the word too). */
const GROUPED = new RegExp(`HAY TELEFERICO ${STAMP.toUpperCase()}`, "u");

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

async function kept(): Promise<
  { question_text: string; page_kind: string; content_id: string | null }[]
> {
  return db`
    select question_text, page_kind, content_id from public.unanswered_questions
    where tenant_id = ${NORTE} and question_key like ${`%${STAMP}%`}
    order by asked_at`;
}

describe("«Lo que preguntan los visitantes» (ADR-053)", () => {
  let placeId = "";
  let placeTitle = "";

  beforeAll(async () => {
    // A clean hour for this visitor in Demo Norte (10 questions per hour, ADR-036).
    await db`
      delete from public.ai_executions where request_id in (
        select id from public.ai_requests where tenant_id = ${NORTE} and profile = 'assistant')`;
    await db`delete from public.ai_requests where tenant_id = ${NORTE} and profile = 'assistant'`;
    const [place] = await db<{ id: string; title: string }[]>`
      select i.id, r.title
      from public.content_items i
      join public.content_revisions r on r.tenant_id = i.tenant_id and r.id = i.published_revision_id
      where i.tenant_id = ${NORTE} and i.slug = 'mirador-del-valle'`;
    placeId = place?.id ?? "";
    placeTitle = place?.title ?? "";
    browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await db.end({ timeout: 5 });
  });

  it("keeps what nothing published answers, masked, and nothing else", async () => {
    expect(placeId).not.toBe("");
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();

    await page.goto(`${PORTAL}/destinos/mirador-del-valle`);
    await page.getByRole("button", { name: /hacer una pregunta/u }).click();
    await ask(page, `Hola, ¿hay teleférico ${STAMP}?`);
    await expect.poll(async () => (await kept()).length, { timeout: 10_000 }).toBe(1);
    // A greeting, and a question the provider could not answer, are not kept.
    await ask(page, "¡Muchas gracias!");
    await ask(page, `[simular:caida] ¿Hay buses al teleférico ${STAMP}?`);

    await page.goto(PORTAL);
    await page.getByRole("button", { name: /hacer una pregunta/u }).click();
    await page.getByRole("button", { name: "Nueva conversación" }).click();
    await ask(page, `HAY TELEFERICO ${STAMP.toUpperCase()}!!`);
    await ask(
      page,
      `¿Me avisan del ${STAMP}? Mi correo es ana.perez@example.com y mi celular 71234567`,
    );
    await expect.poll(async () => (await kept()).length, { timeout: 10_000 }).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect(await kept()).toEqual([
      { question_text: `¿hay teleférico ${STAMP}?`, page_kind: "destination", content_id: placeId },
      {
        question_text: `HAY TELEFERICO ${STAMP.toUpperCase()}!!`,
        page_kind: "home",
        content_id: null,
      },
      {
        question_text: `¿Me avisan del ${STAMP}? Mi correo es [correo] y mi celular [teléfono]`,
        page_kind: "home",
        content_id: null,
      },
    ]);
    // The greeting and the failed one never got there.
    const [others] = await db<{ count: number }[]>`
      select count(*)::int as count from public.unanswered_questions
      where tenant_id = ${NORTE} and (question_key like '%gracias%' or question_key like '%buses%')`;
    expect(others?.count).toBe(0);
    await context.close();
  });

  it("shows the owner the questions grouped, with their pages, and tries one", async () => {
    const { context, page } = await signedIn(OWNER_EMAIL);
    await page.goto(`${ADMIN}/o/demo-norte`);
    await page.getByRole("link", { name: /Lo que preguntan los visitantes/u }).click();
    await page.waitForURL(/\/o\/demo-norte\/preguntas$/u);
    expect(
      await page.getByRole("link", { name: "Últimos 30 días" }).getAttribute("aria-current"),
    ).toBe("page");

    const item = page.locator(".question").filter({ hasText: GROUPED });
    await expect.poll(() => item.count()).toBe(1);
    // Both wordings are one question, shown with the newest one.
    expect(await item.locator(".question-text").innerText()).toContain(
      `HAY TELEFERICO ${STAMP.toUpperCase()}!!`,
    );
    expect(await item.innerText()).toMatch(/2 veces · 1 persona/u);
    // The other one, masked.
    const masked = page.locator(".question").filter({ hasText: `Me avisan del ${STAMP}` });
    expect(await masked.locator(".question-text").innerText()).toContain(
      "Mi correo es [correo] y mi celular [teléfono]",
    );
    expect(await page.locator("main").innerText()).not.toMatch(/ana\.perez|71234567/u);
    const place = item.getByRole("link", { name: `Ficha de «${placeTitle}»` });
    expect(await place.getAttribute("href")).toBe(`/o/demo-norte/destinos/${placeId}`);
    expect(await item.locator(".question-pages").innerText()).toBe(
      `Preguntada en: Ficha de «${placeTitle}» (1), Inicio (1)`,
    );

    await accessible(page);

    await item.getByRole("link", { name: /Probar esta pregunta/u }).click();
    await page.waitForURL(/\/o\/demo-norte\/conocimiento\?pregunta=/u);
    expect(await page.getByLabel("Pregunta de un visitante").inputValue()).toBe(
      `HAY TELEFERICO ${STAMP.toUpperCase()}!!`,
    );
    await context.close();
  });

  it("is there for an editor, and not for another municipality", async () => {
    const editor = await signedIn(EDITOR_EMAIL);
    await editor.page.goto(PAGE);
    await expect
      .poll(() => editor.page.locator(".question").filter({ hasText: GROUPED }).count())
      .toBe(1);
    await editor.context.close();

    const sur = await signedIn(OWNER_SUR_EMAIL);
    const response = await sur.page.goto(PAGE);
    expect(response?.status()).toBe(404);
    await sur.context.close();
  });
});
