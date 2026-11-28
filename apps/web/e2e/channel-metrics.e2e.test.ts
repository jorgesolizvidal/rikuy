/**
 * A · Paso 5.1 (ADR-074) in a real browser against the local stack, with the simulated model:
 *
 * - in Demo Norte, an answer on the portal is kept with its channel («portal»), its kind and
 *   what it cited; tapping a link inside it is kept as what the visitor did after, once;
 * - the same question from «Pregúntale a…» (the QR page) is kept as «qr», and one it does not
 *   know as «sin respuesta»;
 * - nothing of the visitor nor the question's text is kept with them;
 * - the panel's «Estadísticas» shows «El asistente por canal» with both channels, the cited
 *   topic and what was tapped; the monthly report of this month has the same section;
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
const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const NORTE_ID = "5eed1000-0000-4000-8000-000000000001";
const OWNER_EMAIL = "owner@demo-norte.example.test";

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

interface Turn {
  request_id: string;
  channel: string;
  kind: string;
  page_kind: string;
}

/** The turns of Demo Norte, waiting until there are `count` of them. */
async function turns(count: number): Promise<Turn[]> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const rows = await db<Turn[]>`
      select request_id::text, channel, kind, page_kind from public.assistant_turns
      where tenant_id = ${NORTE_ID} order by created_at`;
    if (rows.length >= count) return rows;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`fewer than ${count} turns were kept`);
}

async function actions(requestId: string, count: number) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const rows = await db<{ action: string; content_id: string | null }[]>`
      select action, content_id::text from public.assistant_turn_actions
      where request_id = ${requestId}::uuid`;
    if (rows.length >= count) return rows;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`fewer than ${count} actions were kept`);
}

function thisMonth(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/La_Paz",
    year: "numeric",
    month: "2-digit",
  }).format(new Date());
}

describe("the assistant by channel (ADR-074)", () => {
  let citedTitle = "";

  beforeAll(async () => {
    // A clean count and a clean hour for this visitor (10 questions per hour, ADR-036): the
    // turns go with their requests.
    await db`
      delete from public.ai_executions where request_id in (
        select id from public.ai_requests where tenant_id = ${NORTE_ID} and profile = 'assistant')`;
    await db`delete from public.ai_requests where tenant_id = ${NORTE_ID} and profile = 'assistant'`;
    browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await db.end({ timeout: 5 });
  });

  it("keeps each answer with its channel and what the visitor tapped in it", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();

    // 1. On the portal, from a place's page.
    await page.goto(`${NORTE}/destinos/mirador-del-valle`);
    await page.getByRole("button", { name: /hacer una pregunta/u }).click();
    await page.getByRole("dialog", { name: "Asistente" }).waitFor();
    const answer = await ask(page, "¿Qué se ve desde el mirador?");
    const [portal] = await turns(1);
    expect(portal).toMatchObject({ channel: "portal", kind: "answered", page_kind: "destination" });
    expect(await answer.getAttribute("data-assistant-ref")).toBe(portal?.request_id);
    const cited = await db<{ title: string; slug: string }[]>`
      select coalesce(r.title, i.slug) as title, i.slug
      from public.assistant_turn_citations c
      join public.content_items i on i.id = c.content_id
      left join public.content_revisions r on r.id = i.published_revision_id
      where c.request_id = ${portal?.request_id ?? ""}::uuid`;
    expect(cited.length).toBeGreaterThan(0);
    citedTitle = cited[0]?.title ?? "";

    // 2. Tapping a link inside the answer: once, however many times it is tapped.
    const link = answer.locator('a[href^="/"]').first();
    await link.waitFor();
    const tapped = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/asistente/accion",
    );
    await link.click({ modifiers: ["ControlOrMeta"] });
    const body = JSON.parse((await tapped).postData() ?? "{}") as Record<string, unknown>;
    expect(body.ref).toBe(portal?.request_id);
    expect(typeof body.path).toBe("string");
    expect(Object.keys(body).sort()).toEqual(["path", "ref"]);
    await link.click({ modifiers: ["ControlOrMeta"] });
    expect((await actions(portal?.request_id ?? "", 1)).length).toBe(1);

    // 3. From «Pregúntale a…» (a QR on a sign): the channel is «qr»; one it does not know.
    await page.goto(`${NORTE}/preguntar`);
    await ask(page, "¿Qué se ve desde el mirador?");
    await ask(page, "¿Hay teleférico? [simular:no-sabe]");
    const all = await turns(3);
    expect(all.slice(1).map((row) => [row.channel, row.kind])).toEqual([
      ["qr", "answered"],
      ["qr", "abstained"],
    ]);

    // Nothing of the visitor nor of the question is kept with the answer.
    const columns = await db<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name in ('assistant_turns', 'assistant_turn_actions')`;
    expect(
      columns
        .map((row) => row.column_name)
        .filter((name) => /visitor|ip|text|question/u.test(name)),
    ).toEqual([]);
    await context.close();
  }, 180_000);

  it("shows «El asistente por canal» in «Estadísticas» and in the monthly report", async () => {
    expect(citedTitle).not.toBe("");
    const { context, page } = await signedIn(OWNER_EMAIL);
    await page.goto(`${ADMIN}/o/demo-norte/estadisticas`);
    const section = page.locator("section", {
      has: page.getByRole("heading", { name: "El asistente por canal" }),
    });
    await section.waitFor();
    const table = section.getByRole("region", { name: "Preguntas por canal" });
    expect(await table.getByRole("rowheader", { name: /En el portal/u }).count()).toBe(1);
    expect(
      await table.getByRole("rowheader", { name: /Desde un QR «Pregúntale a…»/u }).count(),
    ).toBe(1);
    expect(await section.innerText()).toContain("Los temas más preguntados");
    expect(await section.getByRole("link", { name: citedTitle }).count()).toBeGreaterThan(0);
    expect(await section.innerText()).toMatch(
      /Abrieron (una ficha|un tour 360°|el mapa|una sección del portal): 1 vez/u,
    );
    await accessible(page, "«Estadísticas» at 1280");
    await page.setViewportSize({ width: 390, height: 844 });
    await accessible(page, "«Estadísticas» at 390");

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${ADMIN}/o/demo-norte/informe?mes=${thisMonth()}`);
    await page.getByRole("heading", { name: "El asistente por canal" }).waitFor();
    await accessible(page, "the monthly report at 1280");
    await context.close();
  }, 120_000);
});
