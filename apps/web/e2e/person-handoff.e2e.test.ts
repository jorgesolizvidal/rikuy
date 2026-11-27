/**
 * A · Paso 4 (ADR-073) in a real browser against the local stack, with the simulated model:
 *
 * - in Demo Norte (its brand has «Atención al visitante» with a WhatsApp), an answer that
 *   knows nothing shows the card: the help desk's name, «Escribir por WhatsApp» with the
 *   question written in the message, «Llamar» and the email; tapping WhatsApp keeps the
 *   question, marked «pidió una persona» and still unanswered;
 * - «Hablar con una persona» is always there: after an answered question on a place's page it
 *   shows the card with that question, and tapping WhatsApp keeps it as answered and taken
 *   to a person, with its place;
 * - written («Quiero hablar con una persona») it gives the card without asking the model, with
 *   the visitor's previous question;
 * - the panel's «Lo que preguntan los visitantes» lists them under «Pidieron hablar con una
 *   persona», and marks the unanswered one; «Marca del portal» has «Atención al visitante»;
 * - Demo Sur (no help desk, only an email) offers the email alone;
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
const NORTE = `http://demo-norte.localhost:${PORT}`;
const SUR = `http://demo-sur.localhost:${PORT}`;
const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const NORTE_ID = "5eed1000-0000-4000-8000-000000000001";
const SUR_ID = "5eed1000-0000-4000-8000-000000000002";
const OWNER_EMAIL = "owner@demo-norte.example.test";
// Letters only, so the run's word never looks like a long number to mask.
const STAMP = Date.now()
  .toString(36)
  .replace(/\d/gu, (digit) => "abcdefghij"[Number(digit)] ?? "x");
const UNKNOWN = "[simular:no-sabe]";

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
    label,
  ).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    `${label} overflows`,
  ).toBe(false);
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
    { timeout: 30_000 },
  );
  return page.locator(".assistant-from-assistant").last();
}

/** Taps «Escribir por WhatsApp» (a new tab, answered here) and waits for the portal's note. */
async function tapWhatsapp(page: Page, card: ReturnType<Page["locator"]>) {
  const told = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/asistente/persona",
  );
  const popup = page.waitForEvent("popup");
  await card.getByRole("link", { name: "Escribir por WhatsApp" }).click();
  await (await popup).close();
  expect((await told).status()).toBe(204);
}

interface Kept {
  question_text: string;
  answered: boolean;
  asked_person: boolean;
  content_id: string | null;
}

async function kept(word: string, wanted: (row: Kept) => boolean): Promise<Kept> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const rows = await db<Kept[]>`
      select question_text, answered, asked_person_at is not null as asked_person, content_id
      from public.unanswered_questions
      where tenant_id = ${NORTE_ID} and question_key like ${`%${word}%`}`;
    const row = rows.find(wanted);
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`nothing kept for «${word}»`);
}

describe("«Hablar con una persona» (ADR-073)", () => {
  let miradorId = "";

  beforeAll(async () => {
    // A clean hour for this visitor in both municipalities (10 questions per hour, ADR-036).
    for (const tenant of [NORTE_ID, SUR_ID]) {
      await db`
        delete from public.ai_executions where request_id in (
          select id from public.ai_requests where tenant_id = ${tenant} and profile = 'assistant')`;
      await db`delete from public.ai_requests where tenant_id = ${tenant} and profile = 'assistant'`;
    }
    const [mirador] = await db<{ id: string }[]>`
      select id from public.content_items
      where tenant_id = ${NORTE_ID} and kind = 'destination' and slug = 'mirador-del-valle'`;
    miradorId = mirador?.id ?? "";
    browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await db.end({ timeout: 5 });
  });

  it("offers the help desk with the question written, and keeps it when the visitor writes", async () => {
    expect(miradorId).not.toBe("");
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    // WhatsApp is not reached: its tab is answered here.
    await context.route("https://wa.me/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/plain", body: "ok" }),
    );
    const page = await context.newPage();
    await page.goto(NORTE);
    await page.getByRole("button", { name: /hacer una pregunta/u }).click();
    const dialog = page.getByRole("dialog", { name: "Asistente" });
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Hablar con una persona" }).waitFor();

    // 1. It does not know: the card comes by itself.
    const unknown = `¿Hay cajero ${STAMP}? ${UNKNOWN}`;
    const abstained = await ask(page, unknown);
    const card = abstained.locator(".assistant-handoff");
    await card.waitFor();
    expect(await card.locator(".assistant-handoff-title").innerText()).toBe("Oficina de turismo");
    const whatsapp = await card
      .getByRole("link", { name: "Escribir por WhatsApp" })
      .getAttribute("href");
    expect(whatsapp).toMatch(/^https:\/\/wa\.me\/59170000001\?text=/u);
    expect(decodeURIComponent(whatsapp?.split("?text=")[1] ?? "")).toBe(
      `Hola, vi el portal de Municipio Demo Norte. Mi consulta: ${unknown}`,
    );
    expect(await card.getByRole("link", { name: /Llamar/u }).getAttribute("href")).toBe(
      "tel:+59140000001",
    );
    expect(
      await card.getByRole("link", { name: "Escribir un correo" }).getAttribute("href"),
    ).toMatch(/^mailto:turismo@demo-norte\.example\.test\?subject=/u);
    await accessible(page, "the card at 390");
    await tapWhatsapp(page, card);
    expect(await kept(STAMP, (row) => row.asked_person)).toMatchObject({
      answered: false,
      asked_person: true,
    });

    // 2. On a place's page it answers; the button takes that question to a person.
    await page.goto(`${NORTE}/destinos/mirador-del-valle`);
    await page.getByRole("button", { name: /hacer una pregunta/u }).click();
    await dialog.waitFor();
    const word = `${STAMP}b`;
    const question = `¿Qué se ve desde el mirador ${word}?`;
    const answer = await ask(page, question);
    expect(await answer.locator(".assistant-handoff").count()).toBe(0);
    await dialog.getByRole("button", { name: "Hablar con una persona" }).click();
    const own = page.locator(".assistant-from-assistant").last().locator(".assistant-handoff");
    await own.waitFor();
    expect(
      decodeURIComponent(
        (
          await own.getByRole("link", { name: "Escribir por WhatsApp" }).getAttribute("href")
        )?.split("?text=")[1] ?? "",
      ),
    ).toContain(`Mi consulta: ${question}`);
    await tapWhatsapp(page, own);
    expect(await kept(word, (row) => row.asked_person)).toMatchObject({
      answered: true,
      content_id: miradorId,
    });

    // 3. Written: the card, without asking the model, with the question before it.
    const [{ count: before } = { count: 0 }] = await db<{ count: number }[]>`
      select count(*)::int as count from public.ai_requests where tenant_id = ${NORTE_ID}`;
    const written = await ask(page, "Quiero hablar con una persona");
    expect(await written.innerText()).toContain("Así puedes hablar con una persona");
    expect(
      decodeURIComponent(
        (
          await written
            .locator(".assistant-handoff")
            .getByRole("link", { name: "Escribir por WhatsApp" })
            .getAttribute("href")
        )?.split("?text=")[1] ?? "",
      ),
    ).toContain(`Mi consulta: ${question}`);
    const [{ count: after } = { count: 0 }] = await db<{ count: number }[]>`
      select count(*)::int as count from public.ai_requests where tenant_id = ${NORTE_ID}`;
    expect(after).toBe(before);
    await page.setViewportSize({ width: 1280, height: 900 });
    await accessible(page, "the card at 1280");
    await context.close();
  }, 180_000);

  it("shows the panel what was taken to a person, and the help desk in the brand", async () => {
    const { context, page } = await signedIn(OWNER_EMAIL);
    await page.goto(`${ADMIN}/o/demo-norte/preguntas?periodo=7-dias`);
    const section = page.getByRole("region", { name: "Pidieron hablar con una persona" });
    await section.waitFor();
    const taken = section.locator(".question");
    expect(await taken.filter({ hasText: STAMP }).count()).toBeGreaterThanOrEqual(2);
    await taken
      .filter({ hasText: `${STAMP}b` })
      .getByText("El asistente respondió")
      .waitFor();
    const unanswered = page
      .getByRole("region", { name: "Las más preguntadas" })
      .locator(".question")
      .filter({ hasText: `cajero ${STAMP}` });
    await unanswered.getByText("Pidió una persona").waitFor();
    // The answered one is not «sin respuesta».
    expect(
      await page
        .getByRole("region", { name: "Las más preguntadas" })
        .locator(".question")
        .filter({ hasText: `${STAMP}b` })
        .count(),
    ).toBe(0);
    await accessible(page, "questions page");

    await page.goto(`${ADMIN}/o/demo-norte/configuracion`);
    const desk = page.getByRole("group", { name: "Atención al visitante" });
    await desk.waitFor();
    expect(await desk.getByLabel("Quién atiende").inputValue()).toBe("Oficina de turismo");
    expect(await desk.getByLabel("WhatsApp").inputValue()).toBe("+591 70000001");
    await accessible(page, "brand editor");
    await context.close();
  }, 120_000);

  it("offers only the email where the municipality has nothing else", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(SUR);
    await page.getByRole("button", { name: /hacer una pregunta/u }).click();
    const dialog = page.getByRole("dialog").first();
    await dialog.getByRole("button", { name: "Hablar con una persona" }).click();
    const card = page.locator(".assistant-handoff").last();
    await card.waitFor();
    expect(await card.locator(".assistant-handoff-title").innerText()).toBe(
      "Atención al visitante",
    );
    expect(await card.getByRole("link").allInnerTexts()).toEqual(["Escribir un correo"]);
    expect(decodeURIComponent((await card.getByRole("link").getAttribute("href")) ?? "")).toContain(
      "Hola, vi el portal de Municipio Demo Sur y tengo una consulta.",
    );
    await accessible(page, "email only");
    await context.close();
  }, 60_000);
});
