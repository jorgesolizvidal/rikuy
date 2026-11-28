/**
 * A · Paso 5.2 (ADR-074) in a real browser against the local stack:
 *
 * - the owner of Demo Sur creates a question in «Preguntas frecuentes» about one of its
 *   destinations; without its answer it is not published; with it, it is;
 * - visitors read it on /preguntas-frecuentes under its topic, with its anchor and FAQPage data
 *   for search engines; the destination's page shows it; the footer and the sitemap link the
 *   page; Demo Norte does not show it;
 * - from «Lo que preguntan los visitantes», «Crear pregunta frecuente con el Copilot» proposes
 *   the question and an answer from what is published (the simulated model), with its sources;
 *   nothing is saved until «Crear el borrador», and then only as a draft; a question nothing
 *   published answers gets no answer and no call to the model;
 * - an analyst sees the questions without creating any, and the Copilot's page is not there;
 * - retiring it takes it off the portal;
 * - the page and the destination's page are checked with axe and for overflow at 390 and 1280 px.
 */
import { drainJobs } from "@rikuy/core";
import { createPostgresJobLedger } from "@rikuy/db/worker";
import { createIndexKnowledgeProcessor } from "@rikuy/worker";
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
// Editor in Demo Norte, analyst in Demo Sur.
const ANALYST_EMAIL = "editor.ambos@example.test";
const STAMP = Date.now().toString(36);
const QUESTION = `¿Hay cajero automático cerca ${STAMP}?`;
const ANSWER = "Sí, en la plaza principal, junto a la alcaldía.";

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

async function memberPage(email: string): Promise<Page> {
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

/** The question on /preguntas-frecuentes, once the portal shows it (its pages were marked stale). */
async function faqItem(page: Page, text: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
    await page.goto(`${PORTAL}/preguntas-frecuentes`);
    const item = page.locator(".faq-item", { hasText: QUESTION });
    if ((await item.count()) > 0 && (await item.innerText()).includes(text)) break;
  }
  return page.locator(".faq-item", { hasText: QUESTION });
}

async function asOwner<T>(work: (sql: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return (await db.begin(async (sql) => {
    await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: OWNER_SUR, role: "authenticated", aal: "aal2" })}, true)`;
    await sql`set local role authenticated`;
    return work(sql);
  })) as T;
}

describe("the municipality's frequently asked questions (ADR-074)", () => {
  beforeAll(async () => {
    const [destination] = await db<{ id: string; slug: string; title: string }[]>`
      select ci.id, ci.slug, r.title
        from public.content_items ci
        join public.content_revisions r on r.id = ci.published_revision_id
       where ci.tenant_id = ${SUR} and ci.kind = 'destination'
       order by ci.created_at limit 1`;
    if (!destination) throw new Error("Demo Sur has no published destination");
    place = destination;
    // What Demo Sur published, indexed by the real indexer (ADR-037), for the Copilot.
    const run = Date.now();
    await db`
      select private.enqueue_job(i.tenant_id, 'knowledge.index',
        'content_revision:' || i.published_revision_id || ':e2e-faq' || ${run}::text,
        jsonb_build_object('source', 'content', 'revisionId', i.published_revision_id),
        'content_revision', i.published_revision_id)
      from public.content_items i
      where i.tenant_id = ${SUR} and i.published_revision_id is not null
    `;
    const ledger = createPostgresJobLedger({
      url: DB_URL,
      role: "rikuy_worker",
      maxConnections: 2,
    });
    try {
      await drainJobs({
        ledger,
        processors: [
          createIndexKnowledgeProcessor({
            knowledge: ledger.knowledge,
            media: { readOriginal: () => Promise.reject(new Error("no documents here")) },
          }),
        ],
        runnerId: "e2e-faq",
        budgetMs: 30_000,
        concurrency: 2,
      });
    } finally {
      await ledger.close();
    }
    browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
    });
  }, 90_000);

  afterAll(async () => {
    // Nothing of this test stays on the portal for the steps that follow.
    await asOwner(async (sql) => {
      const left = await sql<{ id: string }[]>`
        select ci.id from public.content_items ci
         where ci.tenant_id = ${SUR} and ci.kind = 'faq' and ci.published_revision_id is not null`;
      for (const faq of left) await sql`select public.retire_content(${SUR}, ${faq.id})`;
    }).catch(() => undefined);
    await browser?.close();
    await db.end({ timeout: 5 });
  });

  it("publishes a question with its answer, on its page, its place and for search engines", async () => {
    const page = await memberPage(OWNER_EMAIL);
    await page.goto(`${ADMIN}/o/demo-sur`);
    await page.getByRole("link", { name: "Preguntas frecuentes" }).first().click();
    await page.waitForURL(/\/o\/demo-sur\/preguntas-frecuentes$/u);
    await page.goto(`${ADMIN}/o/demo-sur/preguntas-frecuentes?nuevo`);
    await page.getByLabel("Pregunta", { exact: true }).fill(QUESTION);
    await page.getByRole("button", { name: "Crear" }).click();
    await page.waitForURL(/\/o\/demo-sur\/preguntas-frecuentes\/[0-9a-f-]{36}$/u, {
      timeout: 15_000,
    });
    const contentId = page.url().split("/").at(-1) ?? "";

    await page.getByLabel("Tema").selectOption("services");
    await page.getByLabel("¿Sobre qué lugar?").selectOption(place.id);
    // Without its answer it is not published.
    await page.getByRole("button", { name: "Publicar" }).click();
    await page
      .getByText("Escribe la respuesta: sin ella no se publica.")
      .waitFor({ timeout: 15_000 });
    await page.getByLabel("Respuesta", { exact: true }).fill(ANSWER);
    await page.getByLabel("Más detalles").fill("Atiende de lunes a sábado.");
    await page.getByRole("button", { name: "Publicar" }).click();
    await page
      .getByText("Publicada. Ya se ve en la página «Preguntas frecuentes» del portal.")
      .waitFor({ timeout: 15_000 });
    const [audit] = await db<{ diff: { kind?: string } }[]>`
      select diff from public.audit_events
       where action = 'content.published' and entity_id = ${contentId}
       order by occurred_at desc limit 1`;
    expect(audit?.diff).toMatchObject({ kind: "faq" });

    await page.goto(`${ADMIN}/o/demo-sur/preguntas-frecuentes`);
    const row = page.getByRole("row", { name: new RegExp(QUESTION.replace(/[?¿]/gu, ".")) });
    await expect(row.innerText()).resolves.toContain("Servicios");
    await expect(row.innerText()).resolves.toContain("Publicada");

    // Visitors: under «Servicios», with its anchor, details and place.
    const visitor = await visitorPage();
    const item = await faqItem(visitor, ANSWER);
    const slug = await item.getAttribute("id");
    expect(slug).toMatch(/^hay-cajero-automatico-cerca-/u);
    await expect(item.innerText()).resolves.toContain(ANSWER);
    await expect(item.innerText()).resolves.toContain("Atiende de lunes a sábado.");
    await expect(item.getByRole("link", { name: place.title }).getAttribute("href")).resolves.toBe(
      `/destinos/${place.slug}`,
    );
    await expect(
      visitor.getByRole("region", { name: "Servicios", exact: true }).getByText(QUESTION).count(),
    ).resolves.toBe(1);
    // FAQPage data for search engines, with the visible answer.
    const data = JSON.parse(
      (await visitor.locator('script[type="application/ld+json"]').first().textContent()) ?? "{}",
    ) as { "@type"?: string; mainEntity?: { name: string; acceptedAnswer: { text: string } }[] };
    expect(data["@type"]).toBe("FAQPage");
    expect(
      data.mainEntity?.find((entry) => entry.name === QUESTION)?.acceptedAnswer.text,
    ).toContain(ANSWER);
    await expect(
      visitor
        .getByRole("navigation", { name: "Para tu visita" })
        .getByRole("link", { name: /^Preguntas frecuentes/u })
        .getAttribute("href"),
    ).resolves.toBe("/preguntas-frecuentes");
    await accessible(visitor, "/preguntas-frecuentes");
    const sitemap = await (await fetch(`${PORTAL}/sitemap.xml`)).text();
    expect(sitemap).toContain("/preguntas-frecuentes</loc>");

    // The destination's page.
    await visitor.goto(`${PORTAL}/destinos/${place.slug}`);
    const section = visitor.getByRole("region", { name: "Preguntas frecuentes" });
    await expect(section.innerText()).resolves.toContain(QUESTION);
    await expect(section.innerText()).resolves.toContain(ANSWER);
    await expect(
      section.getByRole("link", { name: "Más detalles" }).getAttribute("href"),
    ).resolves.toBe(`/preguntas-frecuentes#${String(slug)}`);
    await accessible(visitor, "a destination with a question");

    // Demo Norte never shows Demo Sur's questions.
    await visitor.goto(`${NORTE}/preguntas-frecuentes`);
    await expect(visitor.getByText(QUESTION).count()).resolves.toBe(0);

    // Retired from the panel: off the portal.
    await page.getByRole("link", { name: QUESTION }).click();
    await page.getByRole("button", { name: "Retirar (ya no aplica)" }).click();
    const confirm = page.getByRole("button", {
      name: "Confirmar: retirar la pregunta del portal y del asistente",
    });
    await confirm.click();
    await confirm.waitFor({ state: "detached", timeout: 15_000 });
    let shown = 1;
    for (let attempt = 0; attempt < 10 && shown > 0; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
      await visitor.goto(`${PORTAL}/preguntas-frecuentes`);
      shown = await visitor.getByText(QUESTION).count();
    }
    expect(shown).toBe(0);
  });

  it("the Copilot proposes it from what is published, and nothing is saved until the draft", async () => {
    const page = await memberPage(OWNER_EMAIL);
    const asked = `¿Qué hay en ${place.title}?`;
    const before = await db<{ count: number }[]>`
      select count(*)::int as count from public.content_items where tenant_id = ${SUR} and kind = 'faq'`;
    await page.goto(
      `${ADMIN}/o/demo-sur/preguntas-frecuentes/copilot?pregunta=${encodeURIComponent(asked)}`,
    );
    await expect(page.getByLabel("Pregunta", { exact: true }).inputValue()).resolves.toBe(asked);
    await page.getByRole("button", { name: "Proponer con el Copilot" }).click();
    await page.getByRole("heading", { name: "De dónde la sacó" }).waitFor({ timeout: 30_000 });
    await expect(page.getByLabel("Respuesta", { exact: true }).inputValue()).resolves.toContain(
      "Respuesta simulada del Copilot",
    );
    const source = page.locator(".faq-proposal-sources a").first();
    await expect(source.getAttribute("href")).resolves.toMatch(/^\/o\/demo-sur\//u);
    // Nothing saved yet.
    const middle = await db<{ count: number }[]>`
      select count(*)::int as count from public.content_items where tenant_id = ${SUR} and kind = 'faq'`;
    expect(middle[0]?.count).toBe(before[0]?.count);
    await accessible(page, "the Copilot's proposal");

    await page.getByRole("button", { name: "Crear el borrador" }).click();
    await page.waitForURL(/\/o\/demo-sur\/preguntas-frecuentes\/[0-9a-f-]{36}$/u, {
      timeout: 15_000,
    });
    const contentId = page.url().split("/").at(-1) ?? "";
    const [saved] = await db<{ published: string | null; summary: string; topic: string }[]>`
      select i.published_revision_id as published, r.summary, r.faq_topic as topic
        from public.content_items i join public.content_revisions r on r.id = i.draft_revision_id
       where i.id = ${contentId}`;
    expect(saved?.published).toBeNull();
    expect(saved?.summary).toContain("Respuesta simulada del Copilot");
    expect(saved?.topic).toBe("services");

    // A question nothing published answers: no answer, and no call to the model.
    const calls = await db<{ count: number }[]>`
      select count(*)::int as count from public.ai_requests where tenant_id = ${SUR}`;
    await page.goto(`${ADMIN}/o/demo-sur/preguntas-frecuentes/copilot`);
    await page.getByLabel("Pregunta", { exact: true }).fill("¿Zzqxw vyktr plomb?");
    await page.getByRole("button", { name: "Proponer con el Copilot" }).click();
    await page
      .getByText("Nada de lo publicado responde esta pregunta.")
      .waitFor({ timeout: 30_000 });
    await expect(page.getByLabel("Respuesta", { exact: true }).inputValue()).resolves.toBe("");
    const after = await db<{ count: number }[]>`
      select count(*)::int as count from public.ai_requests where tenant_id = ${SUR}`;
    expect(after[0]?.count).toBe(calls[0]?.count);

    // The draft is removed: nothing of this test stays.
    await asOwner(async (sql) => {
      const [draft] = await sql<{ edit_count: number }[]>`
        select r.edit_count from public.content_items i
          join public.content_revisions r on r.id = i.draft_revision_id where i.id = ${contentId}`;
      if (draft)
        await sql`select public.discard_content_draft(${SUR}, ${contentId}, ${draft.edit_count})`;
    }).catch(() => undefined);
  });

  it("an analyst sees the questions without creating any; the Copilot's page is not there", async () => {
    const page = await memberPage(ANALYST_EMAIL);
    await page.goto(`${ADMIN}/o/demo-sur/preguntas-frecuentes`);
    await page
      .getByText("Tu rol puede ver las preguntas, pero no crearlas ni cambiarlas.")
      .waitFor({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Nueva pregunta" }).count()).resolves.toBe(0);
    const response = await page.goto(`${ADMIN}/o/demo-sur/preguntas-frecuentes/copilot`);
    expect(response?.status()).toBe(404);
  });
});
