/**
 * C3 · Paso 6 (ADR-065) in a real browser against the local stack, with the simulated model
 * and the real search: the assistant with the design system.
 *
 * - on a phone the launcher is a round icon (its name stays in its accessible name); on a PC it
 *   keeps the name, and the panel opens beside the page;
 * - the header has the municipality's face (logo or initials) and «Responde con lo publicado»;
 *   the greeting is a welcome card and the suggestions are under «Preguntas frecuentes»;
 * - a cited place is a card from what is published (category and its passport stamp), and the
 *   stamp follows this phone: «Sellado en tu pasaporte» once it has it;
 * - «Ruta sugerida» is a card: its stops, the walk in a straight line, the stamps it gives (and
 *   how many this phone has), the route on the map and every stop with its badges;
 * - axe without critical or serious findings and no overflow at 390 and 1280 px.
 */
import { drainJobs } from "@rikuy/core";
import { createPostgresJobLedger } from "@rikuy/db/worker";
import { createIndexKnowledgeProcessor } from "@rikuy/worker";
import axe from "axe-core";
import { chromium, type Browser, type Page } from "playwright-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = Number(process.env.RIKUY_PORT ?? 3000);
const NORTE = `http://demo-norte.localhost:${PORT}`;
const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const NORTE_ID = "5eed1000-0000-4000-8000-000000000001";

const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
let browser: Browser;

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
    await page.evaluate(() => {
      const log = document.querySelector(".assistant-log");
      return (
        document.documentElement.scrollWidth > window.innerWidth ||
        (log !== null && log.scrollWidth > log.clientWidth)
      );
    }),
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

describe("the assistant with the design system (ADR-065)", () => {
  beforeAll(async () => {
    // A clean hour for this visitor (10 questions per hour, ADR-036).
    await db`delete from public.ai_executions where tenant_id = ${NORTE_ID}`;
    await db`delete from public.ai_requests where tenant_id = ${NORTE_ID}`;
    // What the seed published, indexed by the real indexer (ADR-037).
    const run = Date.now();
    await db`
      select private.enqueue_job(i.tenant_id, 'knowledge.index',
        'content_revision:' || i.published_revision_id || ':e2e-cards' || ${run}::text,
        jsonb_build_object('source', 'content', 'revisionId', i.published_revision_id),
        'content_revision', i.published_revision_id)
      from public.content_items i
      where i.tenant_id = ${NORTE_ID} and i.published_revision_id is not null
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
        runnerId: "e2e-assistant-cards",
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
    await browser?.close();
    await db.end({ timeout: 5 });
  });

  it("on a phone: a round launcher, a welcome, place cards and a route card with stamps", async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(`${NORTE}/`);
    const launcher = page.getByRole("button", { name: /hacer una pregunta/u });
    const box = await launcher.boundingBox();
    expect(box && Math.round(box.width)).toBe(box && Math.round(box.height));
    expect(
      await launcher
        .locator(".portal-assistant-launcher-name")
        .evaluate((name) => name.getBoundingClientRect().width),
    ).toBeLessThanOrEqual(1);

    await launcher.click();
    const dialog = page.getByRole("dialog", { name: "Asistente" });
    await dialog.waitFor();
    // Its face (the seed has no logo: the initials) and what it answers from.
    expect(await dialog.locator(".assistant-header .assistant-avatar").innerText()).toBe("DN");
    expect(await dialog.locator(".assistant-status").innerText()).toBe("Responde con lo publicado");
    expect(await dialog.locator(".assistant-welcome").innerText()).toContain(
      "Municipio Demo Norte",
    );
    const faq = dialog.getByRole("group", { name: "Preguntas frecuentes" });
    expect(await faq.getByRole("button").count()).toBe(3);
    await accessible(page, "panel open at 390");

    // A cited place is a card, built from what is published.
    const answer = await ask(page, async () => {
      await page.getByLabel(/Tu pregunta para/u).fill("¿Qué hay en el Mirador del Valle?");
      await page.getByRole("button", { name: "Enviar" }).click();
    });
    const card = answer.locator('.assistant-card[href="/destinos/mirador-del-valle"]');
    await card.waitFor();
    expect(await card.locator(".assistant-card-kicker").innerText()).toMatch(
      /^Destino · Miradores$/iu,
    );
    expect(await card.locator(".assistant-badge").allInnerTexts()).toEqual(["Sello del pasaporte"]);
    await accessible(page, "answer at 390");

    // This phone stamps the lookout: the card says so from then on.
    const [stamp] = await db<{ code: string }[]>`
      select k.code from public.passport_stamp_codes k
      join public.content_items i on i.id = k.content_id
      where i.tenant_id = ${NORTE_ID} and i.slug = 'mirador-del-valle'`;
    await page.goto(`${NORTE}/sello/${stamp?.code ?? ""}`);
    await page.getByRole("button", { name: "Sellar sin compartir mi ubicación" }).click();
    await page.getByText(/¡Sellado!/u).waitFor();
    await page.goto(`${NORTE}/destinos`);
    await page.getByRole("button", { name: /hacer una pregunta/u }).click();
    await dialog.waitFor();
    await expect
      .poll(() =>
        dialog
          .locator('.assistant-card[href="/destinos/mirador-del-valle"] .assistant-badge')
          .allInnerTexts(),
      )
      .toEqual(["✓ Sellado en tu pasaporte"]);

    // «Ruta sugerida»: a card with its summary, its stamps and the route on the map.
    const route = await ask(page, () =>
      dialog.getByRole("button", { name: "Ruta sugerida" }).click(),
    );
    const plan = route.locator(".assistant-plan");
    await plan.waitFor();
    const summary = await plan
      .locator(".assistant-plan-summary > div")
      .evaluateAll((items) =>
        items.map((item) => [
          item.querySelector("dt")?.textContent ?? "",
          item.querySelector("dd")?.textContent ?? "",
        ]),
      );
    expect(summary.map(([term]) => term)).toEqual(["Paradas", "Recorrido", "A pie", "Sellos"]);
    expect(summary[0]?.[1]).toBe("2");
    expect(summary[1]?.[1]).toMatch(/^\d[\d.,]* (m|km)$/u);
    expect(summary[2]?.[1]).toMatch(/^~\d+ (min|h)/u);
    expect(summary[3]?.[1]).toBe("2 (ya tienes 1)");
    const map = await plan
      .getByRole("link", { name: "Ver la ruta en el mapa" })
      .getAttribute("href");
    expect(map).toMatch(/^\/mapa\?ruta=/u);
    expect(map).toContain("destination:mirador-del-valle");
    expect(map).toContain("destination:plaza-principal");
    const stops = await plan.locator(".assistant-plan-stop").evaluateAll((items) =>
      items.map((item) => ({
        href: item.querySelector("a")?.getAttribute("href"),
        media: item.querySelector(".assistant-card-media") !== null,
        badge: item.querySelector(".assistant-badge")?.textContent ?? "",
      })),
    );
    expect(stops).toHaveLength(2);
    expect(stops.every((stop) => stop.media)).toBe(true);
    expect(stops.find((stop) => stop.href === "/destinos/mirador-del-valle")?.badge).toContain(
      "Sellado en tu pasaporte",
    );
    expect(stops.find((stop) => stop.href === "/destinos/plaza-principal")?.badge).toBe(
      "Sello del pasaporte",
    );
    await accessible(page, "route at 390");
    await context.close();
  });

  it("on a PC: the launcher keeps its name and the panel opens beside the page", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${NORTE}/destinos/mirador-del-valle`);
    const launcher = page.getByRole("button", { name: /hacer una pregunta/u });
    expect(await launcher.locator(".portal-assistant-launcher-name").innerText()).toBe("Asistente");
    await launcher.click();
    const dialog = page.getByRole("dialog", { name: "Asistente" });
    await dialog.waitFor();
    const panel = await dialog.boundingBox();
    expect(panel && panel.width).toBeLessThanOrEqual(448);
    expect(panel && panel.x).toBeGreaterThan(600);
    // On a place's page, the suggestions are about it.
    expect(
      await dialog
        .getByRole("group", { name: "Preguntas frecuentes" })
        .getByRole("button")
        .allInnerTexts(),
    ).toEqual(["¿Qué puedo hacer aquí?", "¿Cómo llego?", "¿Qué más hay cerca?"]);
    await ask(page, () => dialog.getByRole("button", { name: "¿Qué puedo hacer aquí?" }).click());
    await accessible(page, "panel at 1280");
    // «Nueva conversación» is an icon now; it still clears the conversation.
    await dialog.getByRole("button", { name: "Nueva conversación" }).click();
    expect(await dialog.locator(".assistant-from-visitor").count()).toBe(0);
    await context.close();
  });
});
