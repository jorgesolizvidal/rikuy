/**
 * C1 · Paso 5 (ADR-055) in a real browser against the local stack and the simulated model:
 * the monthly report for the town hall.
 *
 * - the owner of Demo Norte (with its second factor) opens it from the municipality's page:
 *   the month that ended by default; the current month (to today) has the same figures the
 *   database counts; another month is chosen with the selector; for print, the toolbar and
 *   the email section go away; axe and no overflow at 390 and 1280 px;
 * - «Enviar este informe ahora por correo» puts a job in the queue; the real processor (the
 *   workload's connection, the AI gateway's connection with the simulated model) keeps the
 *   month's recommendations and emails owners and admins a summary that reads without the
 *   panel, with the link; the page then shows when it went out and the recommendations, each
 *   with the figures it rests on; nothing is published nor changed;
 * - an editor reads the report without the email button; another municipality gets a 404.
 */
import {
  createSimulatedAiProvider,
  drainJobs,
  runAiSession,
  type CopilotAiRunner,
  type OutgoingEmail,
} from "@rikuy/core";
import { createPostgresAiLedger } from "@rikuy/db/ai";
import { createPostgresJobLedger } from "@rikuy/db/worker";
import { createMonthlyReportProcessor } from "@rikuy/worker";
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
const OWNER_EMAIL = "owner@demo-norte.example.test";
// Editor in Demo Norte.
const EDITOR_EMAIL = "editor.ambos@example.test";
const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
let browser: Browser;
let today = "";
let month = "";
let previousMonth = "";

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

const monthName = (value: string) =>
  `${MONTHS[Number(value.slice(5, 7)) - 1] ?? ""} de ${value.slice(0, 4)}`;

/** What could be published or proposed: must not move. */
async function contentState(): Promise<string> {
  const rows = await db<{ state: string }[]>`
    select coalesce(string_agg(i.id || ':' || coalesce(i.published_revision_id::text, '-') || ':' ||
             coalesce(i.draft_revision_id::text, '-'), ',' order by i.id), '') ||
           '|' || (select count(*) from public.copilot_proposals p where p.tenant_id = ${NORTE}) as state
    from public.content_items i where i.tenant_id = ${NORTE}`;
  return rows[0]?.state ?? "";
}

/** Runs the queue's monthly reports with the real processor and an email inbox in memory. */
async function runReports(): Promise<OutgoingEmail[]> {
  const inbox: OutgoingEmail[] = [];
  const ledger = createPostgresJobLedger({ url: DB_URL, role: "rikuy_worker", maxConnections: 2 });
  const aiLedger = createPostgresAiLedger({ url: DB_URL, role: "rikuy_ai", maxConnections: 1 });
  const provider = createSimulatedAiProvider();
  const ai: CopilotAiRunner = (input, work) =>
    runAiSession(input, { ledger: aiLedger, provider }, work);
  try {
    await drainJobs({
      ledger,
      processors: [
        createMonthlyReportProcessor({
          reports: ledger.reports,
          ai,
          mailer: { send: async (email) => void inbox.push(email) },
          adminOrigin: ADMIN,
        }),
      ],
      runnerId: "e2e-monthly",
      budgetMs: 30_000,
    });
  } finally {
    await ledger.close();
    await aiLedger.close();
  }
  return inbox;
}

describe("the monthly report (ADR-055)", () => {
  beforeAll(async () => {
    const [row] = await db<{ today: string }[]>`
      select to_char((now() at time zone 'America/La_Paz')::date, 'YYYY-MM-DD') as today`;
    today = row?.today ?? "";
    month = today.slice(0, 7);
    const date = new Date(`${month}-01T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() - 1);
    previousMonth = date.toISOString().slice(0, 7);
    // A clean slate: no saved report, and earlier requests out of today's limit (3 a day).
    await db`delete from public.monthly_reports where tenant_id = ${NORTE}`;
    await db`
      update public.background_jobs set created_at = created_at - interval '2 days'
      where tenant_id = ${NORTE} and kind = 'reports.monthly'`;
    browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await db.end({ timeout: 5 });
  });

  it("reads the month, prints, and emails owners and admins a summary that reads alone", async () => {
    const { context, page } = await signedIn(OWNER_EMAIL);
    await page.goto(`${ADMIN}/o/demo-norte`);
    await page.getByRole("link", { name: /Informe mensual/u }).click();
    await page.waitForURL(/\/o\/demo-norte\/informe$/u);
    // The month that ended, by default.
    await expect
      .poll(() => page.getByRole("heading", { level: 1 }).innerText())
      .toBe(`Informe de ${monthName(previousMonth)}`);

    // Another month, with the selector.
    await page.getByLabel("Mes").selectOption(month);
    await page.getByRole("button", { name: "Ver" }).click();
    await page.waitForURL(new RegExp(`/informe\\?mes=${month}$`, "u"));
    await expect
      .poll(() => page.getByRole("heading", { level: 1 }).innerText())
      .toBe(`Informe de ${monthName(month)} (hasta hoy)`);

    // The same views the database counts for the month, to today.
    const [counted] = await db<{ views: number }[]>`
      select coalesce(sum((i ->> 'views')::int), 0)::int as views
      from jsonb_array_elements(
        private.visit_statistics(${NORTE}, ${`${month}-01`}::date, ${today}::date, false) -> 'items'
      ) i
      where i ->> 'event' = 'view'`;
    const tile = page.locator(".stats-tile", { hasText: "Vistas de páginas" });
    expect(await tile.locator(".stats-tile-value").innerText()).toBe(
      new Intl.NumberFormat("es-BO").format(counted?.views ?? -1),
    );
    for (const heading of [
      "Visitas",
      "Lo más visto",
      "Preguntas sin respuesta",
      "Estado del contenido",
      "Recomendaciones del Copilot",
    ]) {
      await expect.poll(() => page.getByRole("heading", { name: heading }).count()).toBe(1);
    }
    expect(await page.getByText(/se generan solas el día 1 del mes siguiente/u).count()).toBe(1);

    // For print: no toolbar, no email section.
    await page.emulateMedia({ media: "print" });
    expect(await page.locator(".report-toolbar").isVisible()).toBe(false);
    expect(await page.getByRole("heading", { name: "Por correo" }).isVisible()).toBe(false);
    expect(await page.getByRole("heading", { name: "Visitas" }).isVisible()).toBe(true);
    await page.emulateMedia({ media: "screen" });
    await accessible(page);

    // «Enviar este informe ahora por correo».
    const before = await contentState();
    await page.getByRole("button", { name: "Enviar este informe ahora por correo" }).click();
    await page.getByText(/^Listo: el informe está en camino/u).waitFor({ timeout: 15_000 });
    await expect
      .poll(() => page.getByText(/Hay un informe de este mes en camino/u).count())
      .toBe(1);

    const inbox = await runReports();
    const recipients = await db<{ email: string }[]>`
      select distinct u.email::text as email from public.memberships m join auth.users u on u.id = m.user_id
      where m.tenant_id = ${NORTE} and m.status = 'active' and m.role in ('owner', 'admin')
      order by 1`;
    expect(inbox.map((email) => email.to).sort()).toEqual(recipients.map((row) => row.email));
    const email = inbox[0];
    expect(email?.subject).toBe(
      `Informe de ${monthName(month)} (hasta hoy) · Municipio Demo Norte`,
    );
    expect(email?.text).toContain(`${ADMIN}/o/demo-norte/informe?mes=${month}`);
    for (const section of ["VISITAS", "PREGUNTAS SIN RESPUESTA", "ESTADO DEL CONTENIDO"]) {
      expect(email?.text).toContain(section);
    }
    expect(email?.text).toMatch(/RECOMENDACIONES DEL COPILOT\n1\. /u);

    await page.reload();
    await expect.poll(() => page.getByText(/^Se envió el .+ a \d+ personas?\.$/u).count()).toBe(1);
    const items = page.locator(".recommendation");
    await expect.poll(() => items.count()).toBeGreaterThan(0);
    for (let index = 0; index < (await items.count()); index += 1) {
      const item = items.nth(index);
      const why = await item.locator("p").first().innerText();
      const facts = await item.locator(".recommendation-facts li").allInnerTexts();
      expect(facts.length, why).toBeGreaterThan(0);
      const known = new Set(facts.join(" ").match(/\d+(?:[.,]\d+)*/gu) ?? []);
      for (const figure of why.match(/\d+(?:[.,]\d+)*/gu) ?? [])
        expect(known, why).toContain(figure);
    }
    // Nothing published, no draft touched, no proposal made.
    expect(await contentState()).toBe(before);
    const [audit] = await db<{ count: number }[]>`
      select count(*)::int as count from public.audit_events
      where tenant_id = ${NORTE} and action in ('report.monthly_requested', 'report.monthly_generated', 'report.monthly_mailed')`;
    expect(audit?.count).toBeGreaterThanOrEqual(3);

    // Another municipality's report does not exist for this owner.
    const stranger = await page.goto(`${ADMIN}/o/demo-sur/informe`);
    expect(stranger?.status()).toBe(404);
    await context.close();
  });

  it("an editor reads it, without the email button", async () => {
    const { context, page } = await signedIn(EDITOR_EMAIL);
    await page.goto(`${ADMIN}/o/demo-norte/informe?mes=${month}`);
    await expect
      .poll(() => page.getByRole("heading", { level: 1 }).innerText())
      .toBe(`Informe de ${monthName(month)} (hasta hoy)`);
    expect(await page.getByRole("button", { name: /Enviar este informe/u }).count()).toBe(0);
    expect(
      await page.getByText("Solo propietarios y administradores pueden enviarlo.").count(),
    ).toBe(1);
    await context.close();
  });
});
