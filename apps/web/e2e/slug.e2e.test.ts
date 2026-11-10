/**
 * C0 · Paso 1 (ADR-047) in a real browser against the local stack:
 *
 * - the owner of Demo Sur changes the address of a published destination from its editor;
 *   the page visitors had cached at the old address now answers 308 to the new one (also
 *   its tour page), the new one opens, and the sitemap lists only the new one;
 * - the editor lists the old address, which nobody else can take;
 * - going back to the old address works, and the address it left now leads there;
 * - an event changed the same way keeps its page and its calendar file reachable;
 * - the section is checked with axe and for overflow at 390 and 1280 px.
 */
import { request as httpRequest } from "node:http";

import axe from "axe-core";
import { chromium, type Browser, type Page } from "playwright-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { passSecondFactor } from "./support/second-factor";

const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = Number(process.env.RIKUY_PORT ?? 3000);
const ADMIN = `http://app.localhost:${PORT}`;
const PORTAL_HOST = `demo-sur.localhost:${PORT}`;
const PORTAL = `http://${PORTAL_HOST}`;
const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SUR = "5eed1000-0000-4000-8000-000000000002";
const OWNER_SUR = "5eed0000-0000-4000-8000-000000000002";
const OWNER_EMAIL = "owner@demo-sur.example.test";
const STAMP = Date.now().toString(36);
const FIRST = `direccion-${STAMP}`;
const SECOND = `direccion-${STAMP}-nueva`;
const EVENT_FIRST = `evento-${STAMP}`;
const EVENT_SECOND = `evento-${STAMP}-nuevo`;

const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
let browser: Browser;
let destinationId = "";

/** One request to the portal as a visitor would send it, without following redirects. */
function visit(path: string): Promise<{ status: number; location: string | undefined }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port: PORT, path, headers: { host: PORTAL_HOST } },
      (response) => {
        response.resume();
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, location: response.headers.location }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

/** Creates and publishes content as the owner of Demo Sur, through the same RPCs as the panel. */
async function publishedContent(
  kind: "destination" | "event",
  slug: string,
  title: string,
): Promise<string> {
  return db.begin(async (sql) => {
    await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: OWNER_SUR, role: "authenticated", aal: "aal2" })}, true)`;
    await sql`set local role authenticated`;
    const [created] = await sql<{ content_id: string }[]>`
      select content_id from public.create_content_item(${SUR}, ${kind}, ${slug}, ${title})`;
    if (!created) throw new Error("not created");
    const document = {
      title,
      summary: "Para probar el cambio de dirección.",
      body: [],
      location: { lat: -17.6, lng: -65.9 },
      cover: null,
      gallery: [],
      ...(kind === "event"
        ? { schedule: { allDay: true, start: "2031-05-01", end: "2031-05-01" }, venueId: null }
        : {}),
    };
    await sql`select * from public.save_content_draft(${SUR}, ${created.content_id}, ${sql.json(document)}, 1)`;
    await sql`select * from public.publish_content(${SUR}, ${created.content_id}, 2)`;
    return created.content_id;
  });
}

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

async function change(page: Page, slug: string) {
  const section = page.locator("section.slug-field");
  await section.getByRole("button", { name: "Cambiar la dirección" }).click();
  await section.getByLabel("Nueva dirección").fill(slug);
  await section.getByRole("button", { name: "Cambiar la dirección" }).click();
  await section
    .locator(".slug-current")
    .getByText(slug, { exact: true })
    .waitFor({ timeout: 15_000 });
}

describe("changing the address of a destination or event (ADR-047)", () => {
  beforeAll(async () => {
    destinationId = await publishedContent("destination", FIRST, "Dirección de prueba");
    browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await db.end({ timeout: 5 });
  });

  it("keeps old links and QR codes working after the owner changes it", async () => {
    // A visitor opened the page before: it is in the portal's cache.
    expect((await visit(`/destinos/${FIRST}`)).status).toBe(200);

    const page = await ownerPage();
    await page.goto(`${ADMIN}/o/demo-sur/destinos/${destinationId}`);
    const section = page.locator("section.slug-field");
    await expect(section.locator(".slug-current").innerText()).resolves.toContain(FIRST);
    await section.getByRole("button", { name: "Cambiar la dirección" }).click();
    await section.getByLabel("Nueva dirección").fill("Dirección Nueva");
    await section.getByRole("button", { name: "Cambiar la dirección" }).click();
    await expect(section.locator(".field-error").innerText()).resolves.toContain(
      "solo admite minúsculas",
    );
    await accessible(page, "address form");
    await section.getByRole("button", { name: "Cancelar" }).click();

    await change(page, SECOND);
    await expect(section.getByRole("status").innerText()).resolves.toContain(
      `/destinos/${FIRST}) sigue llevando aquí`,
    );
    await expect(section.locator(".slug-previous").innerText()).resolves.toContain(FIRST);
    await expect(page.locator(".portal-share-url").innerText()).resolves.toContain(SECOND);
    await accessible(page, "address with an old one");

    // The cached page at the old address now sends visitors to the new one, in one hop.
    expect(await visit(`/destinos/${FIRST}`)).toEqual({
      status: 308,
      location: `/destinos/${SECOND}`,
    });
    expect(await visit(`/destinos/${FIRST}/tour`)).toEqual({
      status: 308,
      location: `/destinos/${SECOND}/tour`,
    });
    expect((await visit(`/destinos/${SECOND}`)).status).toBe(200);
    const visitor = await browser.newPage();
    const landed = await visitor.goto(`${PORTAL}/destinos/${FIRST}`);
    expect(landed?.status()).toBe(200);
    expect(new URL(visitor.url()).pathname).toBe(`/destinos/${SECOND}`);
    const sitemap = (await (await visitor.goto(`${PORTAL}/sitemap.xml`))?.text()) ?? "";
    expect(sitemap).toContain(`/destinos/${SECOND}<`);
    expect(sitemap).not.toContain(`/destinos/${FIRST}<`);
    await visitor.close();

    // Going back: the old address is the current one again, the one it left leads there.
    await change(page, FIRST);
    expect((await visit(`/destinos/${FIRST}`)).status).toBe(200);
    expect(await visit(`/destinos/${SECOND}`)).toEqual({
      status: 308,
      location: `/destinos/${FIRST}`,
    });
    await page.context().close();
  }, 120_000);

  it("keeps an event's page and calendar file reachable at its old address", async () => {
    const eventId = await publishedContent("event", EVENT_FIRST, "Evento de prueba");
    await db.begin(async (sql) => {
      await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: OWNER_SUR, role: "authenticated", aal: "aal2" })}, true)`;
      await sql`set local role authenticated`;
      await sql`select * from public.change_content_slug(${SUR}, ${eventId}, ${EVENT_FIRST}, ${EVENT_SECOND})`;
    });
    expect(await visit(`/agenda/${EVENT_FIRST}`)).toEqual({
      status: 308,
      location: `/agenda/${EVENT_SECOND}`,
    });
    expect(await visit(`/agenda/${EVENT_FIRST}/calendario.ics`)).toEqual({
      status: 308,
      location: `/agenda/${EVENT_SECOND}/calendario.ics`,
    });
    expect((await visit(`/agenda/${EVENT_SECOND}`)).status).toBe(200);
    // Destinations and events have their own addresses: nothing redirects across them.
    expect((await visit(`/destinos/${EVENT_FIRST}`)).status).toBe(404);
  }, 60_000);
});
