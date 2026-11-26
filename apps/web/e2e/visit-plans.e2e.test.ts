/**
 * A · Paso 3 (ADR-072) in a real browser against the local stack, with the simulated model:
 *
 * - the owner of Demo Sur gives a destination its visit time and «Apto» for children in «Para
 *   tu plan», saves the draft and the database keeps both; an event's editor offers «Para ir
 *   con niños» and no visit time;
 * - in the assistant of Demo Norte, «Plan para hoy» opens «¿Cuánto tiempo tienes?» (1 hora,
 *   2 horas, Medio día, Día completo) and «Con niños»; choosing sends the kind of visit, never
 *   coordinates, and the card says «Plan de 2 horas con niños», when it ends, and «Apto para
 *   niños» on the places the seed marked; no stop ends after that time;
 * - written («Tengo 1 hora») it is a plan too;
 * - axe without critical or serious findings and no overflow at 390 and 1280 px.
 *
 * The plans use the server's clock: after 21:00 in La Paz there is no plan for today, and the
 * test checks that answer instead.
 */
import axe from "axe-core";
import { chromium, type Browser, type Page } from "playwright-core";
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
const SUR_ID = "5eed1000-0000-4000-8000-000000000002";
const OWNER_EMAIL = "owner@demo-sur.example.test";

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

async function ask(page: Page, send: () => Promise<void>) {
  const before = await page.locator(".assistant-from-assistant").count();
  await send();
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll(".assistant-from-assistant").length > count &&
      !document.querySelector(".assistant-typing"),
    before,
    { timeout: 30_000 },
  );
  return page.locator(".assistant-from-assistant").last();
}

/** Minutes from midnight in La Paz (UTC−4, no daylight saving), as the server plans. */
function laPazMinutes(): number {
  const now = new Date(Date.now() - 4 * 3_600_000);
  return now.getUTCHours() * 60 + now.getUTCMinutes();
}

const toMinutes = (time: string) => {
  const [hours, minutes] = time.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
};

describe("plans by kind of visit (ADR-072)", () => {
  beforeAll(async () => {
    // A clean hour for this visitor (10 questions per hour, ADR-036).
    await db`delete from public.ai_executions where tenant_id = ${NORTE_ID}`;
    await db`delete from public.ai_requests where tenant_id = ${NORTE_ID}`;
    browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await db.end({ timeout: 5 });
  });

  it("the editor keeps a destination's visit time and «for children»; an event has only the second", async () => {
    const [laguna] = await db<{ id: string; draft: string | null }[]>`
      select id, draft_revision_id as draft from public.content_items
      where tenant_id = ${SUR_ID} and kind = 'destination' and slug = 'laguna-espejo'`;
    if (!laguna) throw new Error("no laguna in the seed");
    const page = await ownerPage();
    await page.goto(`${ADMIN}/o/demo-sur/destinos/${laguna.id}`);
    const plan = page.getByRole("group", { name: "Para tu plan" });
    await plan.waitFor();
    await plan.getByLabel("Tiempo de visita").selectOption({ label: "1 h 30 min" });
    await plan.getByRole("radio", { name: "Apto" }).check();
    await accessible(page, "destination editor");
    await page.getByRole("button", { name: "Guardar borrador" }).click();
    await page.getByText("Borrador guardado").waitFor({ timeout: 15_000 });
    const [saved] = await db<{ visit: number | null; kids: boolean | null; draft: string }[]>`
      select r.visit_minutes as visit, r.kids_suitable as kids, r.id as draft
      from public.content_items i join public.content_revisions r on r.id = i.draft_revision_id
      where i.id = ${laguna.id}`;
    expect(saved).toMatchObject({ visit: 90, kids: true });
    // Back as the seed left it: no draft.
    if (laguna.draft === null && saved) {
      await db`update public.content_items set draft_revision_id = null where id = ${laguna.id}`;
      await db`delete from public.media_references where revision_id = ${saved.draft}`;
      await db`delete from public.content_revisions where id = ${saved.draft}`;
    }

    const [event] = await db<{ id: string }[]>`
      select id from public.content_items
      where tenant_id = ${SUR_ID} and kind = 'event' order by created_at limit 1`;
    if (!event) throw new Error("no event in the seed");
    await page.goto(`${ADMIN}/o/demo-sur/agenda/${event.id}`);
    const eventPlan = page.getByRole("group", { name: "Para tu plan" });
    await eventPlan.waitFor();
    expect(await eventPlan.getByLabel("Tiempo de visita").count()).toBe(0);
    expect(await eventPlan.getByRole("radio", { name: "No recomendado" }).count()).toBe(1);
    await page.context().close();
  }, 120_000);

  it("«Plan para hoy» opens the kinds of visit and sends the one chosen, never coordinates", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const sent: Record<string, unknown>[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/asistente") {
        sent.push(JSON.parse(request.postData() ?? "{}") as Record<string, unknown>);
      }
    });
    await page.goto(NORTE);
    await page.getByRole("button", { name: /hacer una pregunta/u }).click();
    const dialog = page.getByRole("dialog", { name: "Asistente" });
    await dialog.waitFor();

    const today = dialog.getByRole("button", { name: "Plan para hoy" });
    expect(await today.getAttribute("aria-expanded")).toBe("false");
    const choices = dialog.getByRole("group", { name: "¿Cuánto tiempo tienes?" });
    expect(await choices.isVisible()).toBe(false);
    await today.click();
    expect(await today.getAttribute("aria-expanded")).toBe("true");
    await choices.waitFor();
    expect(await choices.getByRole("button").allInnerTexts()).toEqual([
      "1 hora",
      "2 horas",
      "Medio día",
      "Día completo",
    ]);
    await choices.getByRole("checkbox", { name: "Con niños" }).check();
    await accessible(page, "kinds of visit at 390");

    const asked = laPazMinutes();
    const answer = await ask(page, () => choices.getByRole("button", { name: "2 horas" }).click());
    expect(sent.at(-1)).toMatchObject({
      question: "Plan de 2 horas con niños",
      intent: "today",
      visit: { length: "2h", kids: true },
    });
    expect(JSON.stringify(sent.at(-1))).not.toMatch(/"lat"|"lng"/u);
    // The options close once one is chosen.
    expect(await choices.isVisible()).toBe(false);

    const lateEnough = asked >= 21 * 60 - 3;
    if (lateEnough) {
      expect(await answer.innerText()).toContain("Ya es tarde");
    } else {
      const card = answer.locator(".assistant-plan");
      await card.waitFor();
      expect(await card.locator(".assistant-plan-title").innerText()).toContain(
        "Plan de 2 horas con niños",
      );
      const ends = await card
        .locator(".assistant-plan-summary > div")
        .filter({ hasText: "Termina" })
        .locator("dd")
        .innerText()
        .catch(() => null);
      const stops = await card.locator(".assistant-plan-stop").evaluateAll((items) =>
        items.map((item) => ({
          href: item.querySelector("a")?.getAttribute("href") ?? null,
          time: item.querySelector(".assistant-plan-time")?.textContent ?? null,
          kids: item.querySelector(".assistant-plan-kids")?.textContent ?? null,
        })),
      );
      expect(stops.length).toBeGreaterThan(0);
      // The seed marks the plaza and the mirador as suitable for children.
      for (const stop of stops) {
        if (
          stop.href === "/destinos/plaza-principal" ||
          stop.href === "/destinos/mirador-del-valle"
        ) {
          expect(stop.kids).toBe("Apto para niños");
        }
        if (ends && stop.time) {
          expect(toMinutes(stop.time.split("–")[1] ?? "")).toBeLessThanOrEqual(toMinutes(ends));
        }
      }
      await accessible(page, "plan with children at 390");
    }

    // Written, it is a plan too.
    const written = await ask(page, async () => {
      await dialog.getByLabel(/Tu pregunta para/u).fill("Tengo 1 hora, ¿qué puedo hacer?");
      await dialog.getByRole("button", { name: "Enviar" }).click();
    });
    if (laPazMinutes() >= 21 * 60 - 3) {
      expect(await written.innerText()).toContain("Ya es tarde");
    } else {
      expect(await written.locator(".assistant-plan-title").innerText()).toContain(
        "Plan de 1 hora",
      );
    }
    await context.close();
  }, 120_000);

  it("on a PC the options sit under the buttons, with no overflow", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(NORTE);
    await page.getByRole("button", { name: /hacer una pregunta/u }).click();
    const dialog = page.getByRole("dialog", { name: "Asistente" });
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Plan para hoy" }).click();
    await dialog.getByRole("group", { name: "¿Cuánto tiempo tienes?" }).waitFor();
    await accessible(page, "kinds of visit at 1280");
    await context.close();
  }, 60_000);
});
