/**
 * The visitor's assistant (P5 · Paso 3, ADR-038) in a real browser, against the production
 * build (`next start`), the local Supabase stack and the simulated model (AI_PROVIDER=
 * simulated): no network, deterministic answers that cite their first passage. CI job
 * "Contracts".
 *
 * What it proves: the button is in every page and the panel is downloaded only when it is
 * opened; an answer cites a published page of THIS municipality and links to it; an
 * invented citation and a web address never reach the visitor; a question in English is
 * answered in English; the conversation stays in this browser (24 h) until «Nueva
 * conversación»; the endpoint refuses another origin; with the AI quota used up the visitor
 * gets a notice and the portal; and the panel works by keyboard, on a phone, without axe
 * findings.
 *
 *   SUPABASE_DB_URL=… pnpm --filter @rikuy/web test:e2e-assistant
 */
import http from "node:http";

import { drainJobs } from "@rikuy/core";
import { createPostgresJobLedger } from "@rikuy/db/worker";
import { createIndexKnowledgeProcessor } from "@rikuy/worker";
import axe from "axe-core";
import { chromium, type Browser, type Page } from "playwright-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = Number(process.env.RIKUY_PORT ?? 3000);
const PORTAL = `http://demo-sur.localhost:${PORT}`;
const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SUR = "5eed1000-0000-4000-8000-000000000002";
const STORAGE_KEY = "rikuy.assistant.v1";

const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
let browser: Browser;

async function serious(page: Page): Promise<string[]> {
  await page.addScriptTag({ content: axe.source });
  return page.evaluate(async () => {
    const run = await (
      window as unknown as {
        axe: {
          run: (
            context: Document,
            options: object,
          ) => Promise<{ violations: { id: string; impact: string }[] }>;
        };
      }
    ).axe.run(document, { resultTypes: ["violations"] });
    return run.violations
      .filter((violation) => violation.impact === "critical" || violation.impact === "serious")
      .map((violation) => violation.id);
  });
}

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
  return page.locator(".assistant-from-assistant").last();
}

describe("the visitor's assistant (simulated model)", () => {
  beforeAll(async () => {
    // A clean hour for this visitor (10 questions per hour, ADR-036): earlier runs on the
    // same stack would otherwise count.
    await db`delete from public.ai_executions where tenant_id = ${SUR}`;
    await db`delete from public.ai_requests where tenant_id = ${SUR}`;
    // What the seed published, indexed by the real indexer (ADR-037) under this run's keys.
    const run = Date.now();
    await db`
      select private.enqueue_job(i.tenant_id, 'knowledge.index',
        'content_revision:' || i.published_revision_id || ':e2e' || ${run}::text,
        jsonb_build_object('source', 'content', 'revisionId', i.published_revision_id),
        'content_revision', i.published_revision_id)
      from public.content_items i where i.tenant_id = ${SUR} and i.published_revision_id is not null
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
            // The seed has no documents: the indexer never reads a file here.
            media: {
              readOriginal: () => Promise.reject(new Error("no documents in the seed")),
            },
          }),
        ],
        runnerId: "e2e-assistant",
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
  });

  afterAll(async () => {
    // Demo Sur gets its default AI quota back, today's bucket included.
    await db`delete from public.tenant_quotas where tenant_id = ${SUR} and resource = 'ai_tokens'`;
    await db`
      update public.usage_buckets set limit_amount = private.quota_limit(${SUR}, 'ai_tokens')
      where tenant_id = ${SUR} and resource = 'ai_tokens' and period_end > now()
    `;
    await browser?.close();
    await db.end({ timeout: 5 });
  });

  it("opens from every page, loads only on demand, and answers citing this municipality", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const scripts: string[] = [];
    const hosts = new Set<string>();
    page.on("request", (request) => {
      hosts.add(new URL(request.url()).hostname);
      if (request.resourceType() === "script") scripts.push(request.url());
    });
    for (const path of ["/", "/destinos", "/agenda", "/mapa", "/destinos/laguna-espejo"]) {
      await page.goto(`${PORTAL}${path}`);
      await expect(page.getByRole("button", { name: /hacer una pregunta/u }).count()).resolves.toBe(
        1,
      );
    }
    await page.waitForLoadState("networkidle");
    const loaded = scripts.length;

    const launcher = page.getByRole("button", { name: /hacer una pregunta/u });
    expect((await launcher.innerText()).split("\n")[0]).toBe("Asistente");
    // From here on, only the assistant's requests count (the map asks its own tiles).
    hosts.clear();
    await launcher.click();
    const dialog = page.getByRole("dialog", { name: "Asistente" });
    await dialog.waitFor();
    // The panel's code came now, not with the page.
    expect(scripts.length).toBeGreaterThan(loaded);
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("TEXTAREA");
    expect(await dialog.locator(".assistant-from-assistant").first().innerText()).toContain(
      "Municipio Demo Sur",
    );

    // Asked from the lake's page: it cites the lake, with a link to its page.
    const answer = await ask(page, "¿Qué se ve de noche?");
    const source = answer.locator(".assistant-sources a").first();
    expect(["/destinos/laguna-espejo", "/agenda/noche-de-estrellas"]).toContain(
      await source.getAttribute("href"),
    );
    // Never another municipality's page (Demo Norte has a «Mirador del Valle»).
    const other = await ask(page, "¿Qué hay en el Mirador del Valle?");
    for (const href of await other
      .locator("a")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href")))) {
      expect(href).not.toContain("mirador-del-valle");
    }

    // Validation: an invented citation is dropped; a web address never shows.
    const invented = await ask(page, "laguna [simular:cita-falsa]");
    expect(await invented.locator(".assistant-sources").count()).toBe(0);
    expect(await invented.locator(".assistant-abstained").innerText()).toBe(
      "Sin fuentes publicadas.",
    );
    const linked = await ask(page, "laguna [simular:enlace]");
    expect(await linked.innerText()).not.toContain("ejemplo.invalid");

    // In English, in English.
    const english = await ask(page, "What is there to see at the lake?");
    expect(await english.getAttribute("lang")).toBe("en");

    expect(await serious(page)).toEqual([]);
    // Nothing but this portal and its storage was asked: no third party for the assistant
    // (the place's small map, which any touch of the page wakes up, asks for its tiles).
    expect(
      [...hosts].filter(
        (host) =>
          !host.endsWith("localhost") && host !== "127.0.0.1" && !host.endsWith("openfreemap.org"),
      ),
    ).toEqual([]);

    // Escape closes and gives the focus back to the button.
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("dialog.assistant[open]"));
    expect(await page.evaluate(() => document.activeElement?.className)).toContain(
      "portal-assistant-launcher",
    );

    // The conversation stays in this browser…
    await page.reload();
    await page.getByRole("button", { name: /hacer una pregunta/u }).click();
    await page.locator(".assistant-from-visitor").first().waitFor();
    expect(await page.locator(".assistant-from-visitor").count()).toBe(5);
    const stored = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
    expect(stored).toContain("¿Qué se ve de noche?");
    // …until «Nueva conversación».
    await page.getByRole("button", { name: "Nueva conversación" }).click();
    expect(await page.locator(".assistant-from-visitor").count()).toBe(0);
    expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
    await context.close();
  });

  it("is a modal on a phone, without overflow or axe findings", async () => {
    const context = await browser.newContext({ viewport: { width: 360, height: 780 } });
    const page = await context.newPage();
    await page.goto(`${PORTAL}/`);
    await page.getByRole("button", { name: /hacer una pregunta/u }).click();
    await page.getByRole("dialog").waitFor();
    await ask(page, "¿Qué es la laguna espejo?");
    const box = await page.locator("dialog.assistant").boundingBox();
    expect(box?.width).toBe(360);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false);
    expect(await serious(page)).toEqual([]);
    await context.close();
  });

  it("refuses another origin and a malformed question", async () => {
    // *.localhost is asked at 127.0.0.1 with its Host (not every system resolves it).
    const post = (origin: string, body: string) =>
      new Promise<{ status: number; cache: string | undefined }>((resolve, reject) => {
        const request = http.request(
          {
            host: "127.0.0.1",
            port: PORT,
            path: "/asistente",
            method: "POST",
            headers: {
              host: `demo-sur.localhost:${PORT}`,
              origin,
              "content-type": "application/json",
            },
          },
          (response) => {
            response.resume();
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                cache: response.headers["cache-control"],
              }),
            );
          },
        );
        request.on("error", reject);
        request.end(body);
      });
    expect((await post("http://evil.example", '{"question":"hola"}')).status).toBe(403);
    expect((await post(PORTAL, '{"question":""}')).status).toBe(400);
    expect((await post(PORTAL, "no es json")).status).toBe(400);
    const answered = await post(PORTAL, '{"question":"¿Qué es la laguna espejo?"}');
    expect(answered).toEqual({ status: 200, cache: "no-store" });
  });

  it("with the AI quota used up, the visitor gets a notice and the portal keeps working", async () => {
    await db`
      insert into public.tenant_quotas (tenant_id, resource, limit_amount)
      values (${SUR}, 'ai_tokens', 0)
      on conflict (tenant_id, resource) do update set limit_amount = 0
    `;
    await db`
      update public.usage_buckets set limit_amount = 0
      where tenant_id = ${SUR} and resource = 'ai_tokens' and period_end > now()
    `;
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${PORTAL}/`);
    await page.getByRole("button", { name: /hacer una pregunta/u }).click();
    const notice = await ask(page, "¿Qué es la laguna espejo?");
    expect(await notice.innerText()).toContain("Por hoy ya respondí todas las preguntas");
    expect(
      await notice
        .locator("nav a")
        .evaluateAll((links) => links.map((l) => l.getAttribute("href"))),
    ).toEqual(expect.arrayContaining(["/destinos", "/agenda", "/mapa"]));
    for (const path of ["/", "/destinos", "/destinos/laguna-espejo"]) {
      expect((await page.goto(`${PORTAL}${path}`))?.status()).toBe(200);
    }
    await context.close();
  });
});
