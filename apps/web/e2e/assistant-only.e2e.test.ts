/**
 * A · Paso 2 (ADR-071), «Solo asistente», in a real browser against the local stack (simulated
 * model):
 *
 * - the municipality's website (a page served here at http://localhost:4599, which the seed
 *   authorizes for Demo Sur) pastes the line: the button «Pregúntale a …» appears, opens the
 *   assistant in a frame served by Rikuy that already knows the place the page is about, the
 *   answer links to the website's own page about it (in the same window), and closing gives the
 *   focus back to the button;
 * - the same line on a website that is not authorized (127.0.0.1:4599) shows nothing: the
 *   brand is not given to it, the frame cannot be shown there, and the assistant does not
 *   answer it;
 * - «Pregúntale a …» about a place (what its QR on a sign opens) on Demo Norte, with its portal;
 * - Demo Sur without its portal: its home leads to the assistant, the portal's pages answer
 *   404, robots.txt asks not to index anything, and the answers link only to its website;
 * - the pages are checked with axe and for overflow at 390 and 1280 px.
 *
 * It gives Demo Sur back every module and waits until its portal answers again.
 */
import http from "node:http";
import { request as httpRequest } from "node:http";

import { drainJobs } from "@rikuy/core";
import { createPostgresJobLedger } from "@rikuy/db/worker";
import { createIndexKnowledgeProcessor } from "@rikuy/worker";
import axe from "axe-core";
import { chromium, type Browser, type Frame, type Page } from "playwright-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = Number(process.env.RIKUY_PORT ?? 3000);
const SUR = `http://demo-sur.localhost:${PORT}`;
const NORTE = `http://demo-norte.localhost:${PORT}`;
const WEBSITE = "http://localhost:4599";
const STRANGER = "http://127.0.0.1:4599";
const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SUR_ID = "5eed1000-0000-4000-8000-000000000002";
const NORTE_ID = "5eed1000-0000-4000-8000-000000000001";
const LAKE = "laguna-espejo";
const LAKE_PAGE = `${WEBSITE}/turismo/laguna`;
const NIGHT = "noche-de-estrellas";
const NIGHT_PAGE = `${WEBSITE}/agenda/noche`;

const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
let browser: Browser;
let website: http.Server;

/** The municipality's own website: one page with the line, about the lake. */
function websitePage(): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Web del municipio</title></head>
<body><main><h1>Web oficial del municipio</h1><p>La laguna Espejo.</p></main>
<script src="${SUR}/insertar.js" data-lugar="destinos/${LAKE}" async></script></body></html>`;
}

/** A portal address without following redirects (node:http keeps the portal's Host). */
function get(
  url: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const { host, pathname, search } = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: PORT,
        method,
        path: `${pathname}${search}`,
        headers: { host, ...headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    if (method === "POST") {
      request.setHeader("content-type", "application/json");
      request.write(JSON.stringify({ question: "¿Qué hay en la laguna?" }));
    }
    request.end();
  });
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

async function askIn(target: Page | Frame, question: string) {
  const before = await target.locator(".assistant-from-assistant").count();
  await target.getByLabel(/Tu pregunta para/u).fill(question);
  await target.getByLabel(/Tu pregunta para/u).press("Enter");
  await target.waitForFunction(
    (count) =>
      document.querySelectorAll(".assistant-from-assistant").length > count &&
      !document.querySelector(".assistant-typing"),
    before,
  );
  return target.locator(".assistant-from-assistant").last();
}

/** Polls until the proxy (whose registry is cached for up to a minute) sees the change. */
async function until(check: () => Promise<boolean>, what: string) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("«Solo asistente» (ADR-071)", () => {
  beforeAll(async () => {
    // A clean hour for this visitor (10 questions per hour, ADR-036).
    await db`delete from public.ai_executions where tenant_id in (${SUR_ID}, ${NORTE_ID})`;
    await db`delete from public.ai_requests where tenant_id in (${SUR_ID}, ${NORTE_ID})`;
    // What the seed published, indexed by the real indexer (ADR-037) under this run's keys.
    const run = Date.now();
    await db`
      select private.enqueue_job(i.tenant_id, 'knowledge.index',
        'content_revision:' || i.published_revision_id || ':e2e-only' || ${run}::text,
        jsonb_build_object('source', 'content', 'revisionId', i.published_revision_id),
        'content_revision', i.published_revision_id)
      from public.content_items i
      where i.tenant_id in (${SUR_ID}, ${NORTE_ID}) and i.published_revision_id is not null
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
            media: { readOriginal: () => Promise.reject(new Error("no documents in the seed")) },
          }),
        ],
        runnerId: "e2e-assistant-only",
        budgetMs: 30_000,
        concurrency: 2,
      });
    } finally {
      await ledger.close();
    }
    // The lake's page on the municipality's website (an authorized origin, ADR-071).
    await db`
      update public.content_items set web_url = ${LAKE_PAGE}
      where tenant_id = ${SUR_ID} and kind = 'destination' and slug = ${LAKE}`;
    await db`
      update public.content_items set web_url = ${NIGHT_PAGE}
      where tenant_id = ${SUR_ID} and kind = 'event' and slug = ${NIGHT}`;

    website = http.createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(websitePage());
    });
    await new Promise<void>((resolve) => website.listen(4599, resolve));
    browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
    });
  }, 90_000);

  afterAll(async () => {
    // Demo Sur gets every module back, and the proxy sees it before the next steps.
    await db`
      insert into public.tenant_modules (tenant_id, module)
      select ${SUR_ID}, key from public.platform_modules on conflict do nothing`;
    await db`update public.content_items set web_url = null where tenant_id = ${SUR_ID}`;
    await until(async () => (await get(`${SUR}/destinos`)).status === 200, "the portal back").catch(
      () => undefined,
    );
    await browser?.close();
    await new Promise((resolve) => website?.close(resolve));
    await db.end({ timeout: 5 });
  }, 120_000);

  it("shows the assistant on the municipality's website, about the page's place", async () => {
    const page = await (
      await browser.newContext({ viewport: { width: 1280, height: 900 } })
    ).newPage();
    const posts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST") posts.push(request.url());
    });
    await page.goto(WEBSITE);
    const button = page.getByRole("button", { name: /^Pregúntale a/u });
    await button.waitFor({ timeout: 15_000 });
    await button.click();
    const frameElement = page.locator("iframe[title]");
    await frameElement.waitFor();
    expect(await frameElement.getAttribute("allow")).toBe("microphone; geolocation");
    expect(await frameElement.getAttribute("src")).toBe(
      `${SUR}/insertar?lugar=${encodeURIComponent(`destinos/${LAKE}`)}`,
    );
    await until(
      async () => page.frames().some((frame) => frame.url().startsWith(`${SUR}/insertar`)),
      "the assistant's frame",
    );
    const frame = page.frames().find((candidate) => candidate.url().startsWith(`${SUR}/insertar`));
    if (!frame) throw new Error("the assistant's frame did not load");
    await frame.getByLabel(/Tu pregunta para/u).waitFor();

    // Asked from the lake's page of the website: it answers about the lake, and its source
    // leads to the website's own page, in the same window (never inside the small frame).
    const answer = await askIn(frame, "¿Qué se ve de noche?");
    expect(posts.some((url) => url === `${SUR}/asistente?canal=insertar`)).toBe(true);
    const own = answer.locator(`a[href^="${WEBSITE}/"]`);
    expect(await own.count()).toBeGreaterThan(0);
    for (const link of await own.all()) {
      expect([LAKE_PAGE, NIGHT_PAGE]).toContain(await link.getAttribute("href"));
      expect(await link.getAttribute("target")).toBe("_top");
    }
    // A page of the portal opens in another tab.
    for (const link of await answer.locator("a[href^='http://demo-sur']").all()) {
      expect(await link.getAttribute("target")).toBe("_blank");
    }

    // Closing gives the focus back to the website's button.
    await frame.getByRole("button", { name: "Cerrar el asistente" }).click();
    await page.waitForFunction(() => {
      const host = document.querySelector("[data-rikuy-assistant]");
      const iframe = host?.shadowRoot?.querySelector("iframe");
      return iframe?.hidden === true;
    });
    expect(
      await page.evaluate(
        () => document.querySelector("[data-rikuy-assistant]")?.shadowRoot?.activeElement?.tagName,
      ),
    ).toBe("BUTTON");
    await page.context().close();
  });

  it("shows nothing on a website that is not authorized, and nobody else can use it", async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(STRANGER);
    await page.waitForLoadState("networkidle");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await page.locator("[data-rikuy-assistant]").count()).toBe(0);
    await page.context().close();

    const refused = await get(`${SUR}/insertar/marca`, { origin: STRANGER });
    expect(refused.status).toBe(403);
    expect(refused.headers["access-control-allow-origin"]).toBeUndefined();
    const brand = await get(`${SUR}/insertar/marca`, { origin: WEBSITE });
    expect(brand.status).toBe(200);
    expect(brand.headers["access-control-allow-origin"]).toBe(WEBSITE);
    expect((JSON.parse(brand.body) as { label: string }).label).toMatch(/^Pregúntale a/u);

    // Only the authorized website may show the frame; every other page of the portal, nobody.
    const frame = await get(`${SUR}/insertar`);
    expect(frame.headers["content-security-policy"]).toBe(`frame-ancestors 'self' ${WEBSITE}`);
    expect(frame.headers["x-frame-options"]).toBeUndefined();
    const north = await get(`${NORTE}/insertar`);
    expect(north.headers["content-security-policy"]).toBe("frame-ancestors 'self'");
    expect((await get(`${SUR}/destinos`)).headers["x-frame-options"]).toBe("DENY");
    // The assistant answers only from its own frame, never a call from the website itself.
    expect((await get(`${SUR}/asistente`, { origin: WEBSITE }, "POST")).status).toBe(403);
  });

  it("opens «Pregúntale a …» about a place, the page its QR on a sign opens", async () => {
    const [place] = await db<{ slug: string; title: string }[]>`
      select i.slug, r.title from public.content_items i
      join public.content_revisions r on r.id = i.published_revision_id
      where i.tenant_id = ${NORTE_ID} and i.kind = 'destination' order by i.slug limit 1`;
    if (!place) throw new Error("Demo Norte needs a published destination");
    const page = await (
      await browser.newContext({ viewport: { width: 1280, height: 900 } })
    ).newPage();
    const bodies: unknown[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/asistente")) {
        bodies.push({ url: request.url(), body: request.postDataJSON() as unknown });
      }
    });
    const response = await page.goto(`${NORTE}/preguntar/destinos/${place.slug}`);
    expect(response?.status()).toBe(200);
    expect(response?.headers()["x-frame-options"]).toBe("DENY");
    await page.getByRole("heading", { level: 1, name: /Pregúntale a/u }).waitFor();
    expect(await page.getByText(place.title, { exact: true }).count()).toBeGreaterThan(0);
    expect(await page.getByRole("link", { name: "Ver su ficha" }).getAttribute("href")).toBe(
      `/destinos/${place.slug}`,
    );
    expect(await page.locator('meta[name="robots"]').getAttribute("content")).toContain("noindex");
    await page.getByLabel(/Tu pregunta para/u).waitFor();
    await askIn(page, "¿Qué puedo hacer aquí?");
    expect(bodies[0]).toMatchObject({
      url: `${NORTE}/asistente?canal=qr`,
      body: { page: { kind: "destination", slug: place.slug } },
    });
    await accessible(page, "«Pregúntale a …»");
    // A place that is not published has no such page.
    expect((await get(`${NORTE}/preguntar/destinos/no-existe`)).status).toBe(404);
    expect((await get(`${NORTE}/preguntar/servicios/${place.slug}`)).status).toBe(404);
    await page.context().close();
  });

  it("without its portal, only the assistant: answers link to the municipality's website", async () => {
    await db`
      delete from public.tenant_modules
      where tenant_id = ${SUR_ID} and module in ('portal', 'map', 'tours', 'models', 'passport')`;
    await until(async () => (await get(`${SUR}/`)).status === 307, "the portal off");

    const home = await get(`${SUR}/`);
    expect(new URL(home.headers.location ?? "", SUR).href).toBe(`${SUR}/preguntar`);
    for (const path of ["/destinos", `/destinos/${LAKE}`, "/agenda", "/sitemap.xml", "/avisos"]) {
      expect((await get(`${SUR}${path}`)).status, path).toBe(404);
    }
    expect((await get(`${SUR}/robots.txt`)).body).toContain("Disallow: /");

    const page = await (
      await browser.newContext({ viewport: { width: 390, height: 844 } })
    ).newPage();
    const privacy = await page.goto(`${SUR}/privacidad`);
    expect(privacy?.status()).toBe(200);
    expect(await page.getByRole("navigation", { name: "Principal" }).count()).toBe(0);
    expect(await page.getByRole("navigation", { name: "Secciones" }).count()).toBe(0);

    await page.goto(`${SUR}/preguntar/destinos/${LAKE}`);
    expect(
      await page.getByRole("link", { name: "Ver en la web del municipio" }).getAttribute("href"),
    ).toBe(LAKE_PAGE);
    expect(await page.getByRole("link", { name: "Ver el portal" }).count()).toBe(0);
    await page.getByLabel(/Tu pregunta para/u).waitFor();
    const answer = await askIn(page, "¿Qué se ve de noche?");
    // No section of a portal it does not have, and no portal page: only the website's.
    for (const href of await answer
      .locator("a")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""))) {
      expect(href.startsWith("/"), href).toBe(false);
    }
    expect(await answer.locator(`a[href^="${WEBSITE}/"]`).count()).toBeGreaterThan(0);
    await accessible(page, "«Pregúntale a …» sin portal");
    await page.context().close();
  }, 150_000);
});
