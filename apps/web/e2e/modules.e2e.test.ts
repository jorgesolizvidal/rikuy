/**
 * C3 · Paso 1 (ADR-060) in a real browser against the local stack: the modules of a
 * municipality.
 *
 * - the operator (with its second factor) turns off the agenda, the map, the tours (and with
 *   them the 3D models) and the passport of Demo Sur, confirming first; it is audited;
 * - the portal of Demo Sur no longer links them, their pages answer 404 (a tour's page leads to
 *   its place), the sitemap leaves them out; Demo Norte is untouched;
 * - its owner no longer sees those cards in the panel, their pages answer 404, and the
 *   database refuses a new event; nothing was deleted;
 * - turned on again from the same page, everything comes back as it was.
 */
import { request as httpRequest } from "node:http";

import axe from "axe-core";
import { chromium, type Browser, type Page } from "playwright-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { passSecondFactor, totp } from "./support/second-factor";

const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = Number(process.env.RIKUY_PORT ?? 3000);
const ADMIN = `http://app.localhost:${PORT}`;
const SUR = `http://demo-sur.localhost:${PORT}`;
const NORTE = `http://demo-norte.localhost:${PORT}`;
const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SUR_ID = "5eed1000-0000-4000-8000-000000000002";
const OPERATOR = "operador@rikuy.example.test";
const OPERATOR_ID = "5eed0000-0000-4000-8000-000000000005";
const OWNER_SUR = "owner@demo-sur.example.test";
const ALL = ["agenda", "map", "tours", "models", "passport", "assistant", "voice", "copilot"];

const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
let browser: Browser;
let operator: Page;

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

async function signIn(email: string): Promise<Page> {
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
    expect(
      result.violations
        .filter((violation) => violation.impact === "critical" || violation.impact === "serious")
        .map((violation) => violation.id),
      `${label} at ${width} px`,
    ).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      `${label} overflows at ${width} px`,
    ).toBe(false);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function modulesOfSur(): Promise<string[]> {
  const rows = await db<{ module: string }[]>`
    select m.module from public.tenant_modules m
    join public.platform_modules p on p.key = m.module
    where m.tenant_id = ${SUR_ID} order by p.position`;
  return rows.map((row) => row.module);
}

/** A portal address without following redirects (node:http keeps the portal's Host). */
function get(url: string): Promise<{ status: number; location: string | null; body: string }> {
  const { host, pathname, search } = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port: PORT, path: `${pathname}${search}`, headers: { host } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            location: response.headers.location ?? null,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

const status = get;

describe("the modules of a municipality (ADR-060)", () => {
  beforeAll(async () => {
    // The operator enrolls through /plataforma below; an earlier factor has an unknown key.
    await db`delete from auth.mfa_factors where user_id = ${OPERATOR_ID}`;
    browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
    });
  }, 60_000);

  afterAll(async () => {
    // Whatever happened, Demo Sur keeps every module for the steps after this one.
    await db`
      insert into public.tenant_modules (tenant_id, module)
      select ${SUR_ID}, key from public.platform_modules on conflict do nothing`;
    await browser?.close();
    await db.end({ timeout: 5 });
  });

  it("the operator turns modules off, after confirming, and it is audited", async () => {
    expect(await modulesOfSur()).toEqual(ALL);
    operator = await signIn(OPERATOR);
    await operator.goto(`${ADMIN}/plataforma`);
    await operator.getByRole("button", { name: "Configurar la app de autenticación" }).click();
    const secret = (await operator.locator("code.secret").innerText()).trim();
    await operator.getByLabel("Código de 6 dígitos").fill(totp(secret));
    await operator.getByRole("button", { name: "Verificar" }).click();
    await operator.getByRole("heading", { level: 1, name: "Plataforma" }).waitFor();

    await operator.getByRole("link", { name: /cambiar los de Municipio Demo Sur/u }).click();
    await operator.waitForURL(/\/plataforma\/modulos\/demo-sur$/u);
    await operator
      .getByRole("heading", { level: 1, name: /Módulos de Municipio Demo Sur/u })
      .waitFor();
    await accessible(operator, "/plataforma/modulos");

    for (const name of ["Agenda", "Mapa", "Tours 360°", "Pasaporte turístico"]) {
      await operator.getByLabel(name, { exact: true }).uncheck();
    }
    // The 3D models go with the tours and cannot be turned on alone.
    expect(await operator.getByLabel("Modelos 3D", { exact: true }).isChecked()).toBe(false);
    expect(await operator.getByLabel("Modelos 3D", { exact: true }).isDisabled()).toBe(true);

    await operator.getByRole("button", { name: "Guardar los módulos" }).click();
    await operator
      .getByText(/Vas a apagar «Agenda», «Mapa», «Tours 360°», «Modelos 3D»/u)
      .waitFor();
    expect(await modulesOfSur()).toEqual(ALL);
    await operator.getByRole("button", { name: "Sí, guardar los módulos" }).click();
    await operator.getByText("Se guardaron los módulos.", { exact: false }).waitFor();
    expect(await modulesOfSur()).toEqual(["assistant", "voice", "copilot"]);

    const [audit] = await db<{ diff: { from: string[]; to: string[] } }[]>`
      select diff from public.audit_events
      where tenant_id = ${SUR_ID} and action = 'platform.modules_changed'
      order by occurred_at desc limit 1`;
    expect(audit?.diff).toEqual({ from: ALL, to: ["assistant", "voice", "copilot"] });
  });

  it("the portal of Demo Sur no longer offers them; Demo Norte does", async () => {
    const page = await (
      await browser.newContext({ viewport: { width: 390, height: 800 } })
    ).newPage();
    await page.goto(SUR);
    const nav = page.getByRole("navigation", { name: "Principal" });
    await nav.waitFor();
    expect(await nav.getByRole("link", { name: "Destinos" }).count()).toBe(1);
    for (const name of ["Agenda", "Mapa", "Tours 360°", "Pasaporte"]) {
      expect(await nav.getByRole("link", { name, exact: true }).count(), name).toBe(0);
    }
    expect(await page.getByRole("heading", { name: "Próximos eventos" }).count()).toBe(0);
    await accessible(page, "inicio sin módulos");

    for (const path of ["/agenda", "/mapa", "/recorrido", "/pasaporte"]) {
      expect((await status(`${SUR}${path}`)).status, path).toBe(404);
    }
    const [event] = await db<{ slug: string }[]>`
      select slug from public.content_items
      where tenant_id = ${SUR_ID} and kind = 'event' and published_revision_id is not null limit 1`;
    if (event) expect((await status(`${SUR}/agenda/${event.slug}`)).status).toBe(404);
    const [place] = await db<{ slug: string }[]>`
      select slug from public.content_items
      where tenant_id = ${SUR_ID} and kind = 'destination' and published_revision_id is not null
      order by slug limit 1`;
    if (!place) throw new Error("Demo Sur needs a published destination");
    // A tour's page leads to its place's page.
    const tour = await status(`${SUR}/destinos/${place.slug}/tour`);
    expect(tour.status).toBe(307);
    expect(tour.location).toMatch(new RegExp(`/destinos/${place.slug}$`, "u"));
    const ficha = await page.goto(`${SUR}/destinos/${place.slug}`);
    expect(ficha?.status()).toBe(200);
    expect(await page.getByRole("link", { name: "Ver en el mapa del municipio" }).count()).toBe(0);
    expect(await page.getByRole("link", { name: /Ver el tour 360°/u }).count()).toBe(0);

    const sitemap = (await get(`${SUR}/sitemap.xml`)).body;
    expect(sitemap).toContain("/destinos</loc>");
    expect(sitemap).not.toContain("/agenda</loc>");
    expect(sitemap).not.toContain("/mapa</loc>");

    await page.goto(NORTE);
    const north = page.getByRole("navigation", { name: "Principal" });
    expect(await north.getByRole("link", { name: "Agenda", exact: true }).count()).toBe(1);
    expect(await north.getByRole("link", { name: "Mapa", exact: true }).count()).toBe(1);
    expect((await status(`${NORTE}/mapa`)).status).toBe(200);
  });

  it("its panel hides them and the database refuses new content of a module that is off", async () => {
    const owner = await signIn(OWNER_SUR);
    await passSecondFactor(owner, ADMIN);
    await owner.goto(`${ADMIN}/o/demo-sur`);
    await owner.getByRole("heading", { level: 1, name: "Municipio Demo Sur" }).waitFor();
    expect(await owner.getByRole("link", { name: /^Destinos/u }).count()).toBe(1);
    for (const name of ["Agenda", "Tours 360°", "Panoramas 360°", "Modelos 3D", "Pasaporte"]) {
      expect(
        await owner.getByRole("link", { name: new RegExp(`^${name}`, "u") }).count(),
        name,
      ).toBe(0);
    }
    expect(await owner.getByRole("link", { name: /^Copilot/u }).count()).toBe(1);
    expect(
      await owner.getByText(/Módulos de este municipio: Asistente del visitante/u).count(),
    ).toBe(1);
    await accessible(owner, "/o/demo-sur sin módulos");
    for (const path of ["agenda", "tours", "panoramas", "modelos", "pasaporte"]) {
      const response = await owner.goto(`${ADMIN}/o/demo-sur/${path}`);
      expect(response?.status(), path).toBe(404);
    }

    // Nothing was deleted: the events and tours of Demo Sur are still there.
    const [kept] = await db<{ events: number; tours: number }[]>`
      select (select count(*)::int from public.content_items where tenant_id = ${SUR_ID} and kind = 'event') as events,
             (select count(*)::int from public.tours where tenant_id = ${SUR_ID}) as tours`;
    expect(kept?.events).toBeGreaterThan(0);

    // The database refuses a new event even if someone calls it directly.
    const refused = await db
      .begin(async (sql) => {
        await sql`select set_config('request.jwt.claims', ${JSON.stringify({
          sub: "5eed0000-0000-4000-8000-000000000002",
          role: "authenticated",
          aal: "aal2",
        })}, true)`;
        await sql`set local role authenticated`;
        await sql`select public.create_content_item(${SUR_ID}, 'event', 'feria-nueva', 'Feria')`;
        return "created";
      })
      .catch((error: { code?: string }) => error.code ?? "unknown");
    expect(refused).toBe("PT403");
    await owner.context().close();
  });

  it("turned on again, everything comes back as it was", async () => {
    await operator.goto(`${ADMIN}/plataforma/modulos/demo-sur`);
    for (const name of ["Agenda", "Mapa", "Tours 360°", "Pasaporte turístico"]) {
      await operator.getByLabel(name, { exact: true }).check();
    }
    await operator.getByLabel("Modelos 3D", { exact: true }).check();
    // Nothing turned off: no confirmation.
    await operator.getByRole("button", { name: "Guardar los módulos" }).click();
    await operator.getByText("Se guardaron los módulos.", { exact: false }).waitFor();
    expect(await modulesOfSur()).toEqual(ALL);

    const page = await (
      await browser.newContext({ viewport: { width: 1280, height: 900 } })
    ).newPage();
    await page.goto(SUR);
    const nav = page.getByRole("navigation", { name: "Principal" });
    expect(await nav.getByRole("link", { name: "Agenda", exact: true }).count()).toBe(1);
    expect(await nav.getByRole("link", { name: "Mapa", exact: true }).count()).toBe(1);
    expect((await status(`${SUR}/agenda`)).status).toBe(200);
    expect((await status(`${SUR}/mapa`)).status).toBe(200);
  });
});
