/**
 * C2 · Paso 1 (ADR-056) in a real browser against the local stack: the circuits of the
 * tourist passport.
 *
 * - the portal of Demo Norte has «Pasaporte» in its header, the passport page and the seed's
 *   circuit with its published stops in the suggested order (never the draft destination), its
 *   prize and the route on the map; it is in the sitemap; Demo Sur has none of it; axe and no
 *   overflow at 390 and 1280 px;
 * - in the panel, the owner of Demo Norte creates a circuit, adds stops, saves, sees why it
 *   cannot be published yet, publishes it (the portal shows it on the next visit, its cache
 *   refreshed) and withdraws it (gone); an editor creates a draft but cannot change a published
 *   circuit; another municipality's circuit is a 404.
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
const OWNER_EMAIL = "owner@demo-norte.example.test";
// Editor in Demo Norte.
const EDITOR_EMAIL = "editor.ambos@example.test";
const TEST_SLUGS = ["ruta-de-prueba", "borrador-del-editor"];

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

async function cleanUp() {
  await db`delete from public.passport_circuits where tenant_id = ${NORTE_ID} and slug = any(${TEST_SLUGS})`;
}

describe("the tourist passport's circuits (ADR-056)", () => {
  beforeAll(async () => {
    await cleanUp();
    browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await cleanUp();
    await db.end({ timeout: 5 });
  });

  it("shows the published circuits in the portal, only of its municipality", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${NORTE}/`);
    await page
      .getByRole("navigation", { name: "Principal" })
      .getByRole("link", { name: "Pasaporte" })
      .click();
    await page.waitForURL(`${NORTE}/pasaporte`);
    await page.getByRole("heading", { level: 1, name: "Pasaporte turístico" }).waitFor();
    expect(await page.getByText("2 lugares: Plaza principal, Mirador del Valle").count()).toBe(1);
    expect(await page.getByText("Feria de los domingos").count()).toBe(0);
    await accessible(page);

    await page.getByRole("link", { name: "Ruta del valle" }).click();
    await page.waitForURL(`${NORTE}/pasaporte/ruta-del-valle`);
    expect(await page.locator(".passport-stops .portal-card-title").allInnerTexts()).toEqual([
      "Plaza principal",
      "Mirador del Valle",
    ]);
    expect(await page.getByText(/Una postal del valle/u).count()).toBe(1);
    expect(
      await page.getByRole("link", { name: "Ver el recorrido en el mapa" }).getAttribute("href"),
    ).toBe("/mapa?ruta=destination:plaza-principal,destination:mirador-del-valle");
    await accessible(page);

    const sitemap = await (await page.goto(`${NORTE}/sitemap.xml`))?.text();
    expect(sitemap).toContain("/pasaporte/ruta-del-valle");
    expect(await (await page.goto(`${SUR}/sitemap.xml`))?.text()).not.toContain("/pasaporte");

    // Demo Sur: no circuits, no link; the page still answers and says so.
    await page.goto(`${SUR}/`);
    expect(await page.getByRole("link", { name: "Pasaporte" }).count()).toBe(0);
    await page.goto(`${SUR}/pasaporte`);
    expect(
      await page.getByText("Pronto publicaremos aquí los circuitos del pasaporte.").count(),
    ).toBe(1);
    const other = await page.goto(`${SUR}/pasaporte/ruta-del-valle`);
    expect(other?.status()).toBe(404);
    await context.close();
  });

  it("lets the owner build, publish and withdraw a circuit", async () => {
    const { context, page } = await signedIn(OWNER_EMAIL);
    await page.goto(`${ADMIN}/o/demo-norte`);
    await page.getByRole("link", { name: /Pasaporte turístico/u }).click();
    await page.waitForURL(`${ADMIN}/o/demo-norte/pasaporte`);
    expect(await page.getByRole("link", { name: "Ruta del valle" }).count()).toBe(1);
    await accessible(page);

    await page.getByLabel("Nombre del circuito").fill("Ruta de prueba");
    expect(await page.getByLabel("Dirección en el portal").inputValue()).toBe("ruta-de-prueba");
    await page.getByRole("button", { name: "Crear circuito" }).click();
    await page.waitForURL(/\/o\/demo-norte\/pasaporte\/[0-9a-f-]{36}$/u);
    await page.getByRole("heading", { level: 1, name: "Ruta de prueba" }).waitFor();

    // One published destination is not enough to publish.
    await page.getByLabel("Agregar un destino").selectOption({ label: "Mirador del Valle" });
    await page.getByRole("button", { name: "Agregar", exact: true }).click();
    await page.getByLabel("Premio al completarlo").fill("Un llavero en la oficina de turismo.");
    await page.getByRole("button", { name: "Guardar", exact: true }).click();
    await page.getByText("Se guardó.").waitFor();
    await page.getByText("Agrega al menos un destino publicado más (hacen falta dos).").waitFor();
    expect(await page.getByRole("button", { name: "Publicar el circuito" }).isDisabled()).toBe(
      true,
    );

    await page.getByLabel("Agregar un destino").selectOption({ label: "Plaza principal" });
    await page.getByRole("button", { name: "Agregar", exact: true }).click();
    await page.getByRole("button", { name: "Subir «Plaza principal»" }).click();
    await page.getByRole("button", { name: "Guardar", exact: true }).click();
    await page.getByText("Se guardó.").waitFor();
    await accessible(page);
    await page.getByRole("button", { name: "Publicar el circuito" }).click();
    await page.getByText("Se publicó: el circuito ya está en el portal.").waitFor();

    const [row] = await db<{ status: string; stops: string[] }[]>`
      select c.status, array_agg(i.slug order by s.position) as stops
      from public.passport_circuits c
      join public.passport_circuit_stops s on s.circuit_id = c.id
      join public.content_items i on i.id = s.content_id
      where c.tenant_id = ${NORTE_ID} and c.slug = 'ruta-de-prueba'
      group by c.status`;
    expect(row).toEqual({ status: "published", stops: ["plaza-principal", "mirador-del-valle"] });

    const visitor = await browser.newPage();
    await visitor.goto(`${NORTE}/pasaporte`);
    expect(await visitor.getByRole("link", { name: "Ruta de prueba" }).count()).toBe(1);
    expect(await visitor.getByText(/Un llavero en la oficina de turismo/u).count()).toBe(1);

    await page.getByRole("button", { name: "Retirar del portal" }).click();
    await page.getByText(/Se retiró del portal/u).waitFor();
    await visitor.goto(`${NORTE}/pasaporte`);
    expect(await visitor.getByRole("link", { name: "Ruta de prueba" }).count()).toBe(0);
    // A circuit visitors saw is withdrawn, never deleted.
    expect(await page.getByRole("button", { name: "Borrar el circuito" }).count()).toBe(0);
    await visitor.close();

    const [audit] = await db<{ count: number }[]>`
      select count(*)::int as count from public.audit_events
      where tenant_id = ${NORTE_ID}
        and action in ('passport.circuit_created', 'passport.circuit_published', 'passport.circuit_withdrawn')`;
    expect(audit?.count).toBeGreaterThanOrEqual(3);

    // Demo Sur's circuits do not exist for this owner.
    const stranger = await page.goto(`${ADMIN}/o/demo-sur/pasaporte`);
    expect(stranger?.status()).toBe(404);
    await context.close();
  });

  it("lets an editor build drafts, never change a published circuit", async () => {
    const { context, page } = await signedIn(EDITOR_EMAIL);
    await page.goto(`${ADMIN}/o/demo-norte/pasaporte`);
    await page.getByLabel("Nombre del circuito").fill("Borrador del editor");
    await page.getByRole("button", { name: "Crear circuito" }).click();
    await page.waitForURL(/\/o\/demo-norte\/pasaporte\/[0-9a-f-]{36}$/u);
    expect(await page.getByRole("button", { name: "Publicar el circuito" }).count()).toBe(0);

    await page.goto(`${ADMIN}/o/demo-norte/pasaporte`);
    await page.getByRole("link", { name: "Ruta del valle" }).click();
    await page
      .getByText("Este circuito está publicado: solo propietarios y administradores lo cambian.")
      .waitFor();
    expect(await page.getByLabel("Nombre", { exact: true }).isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: /Guardar/u }).count()).toBe(0);
    await context.close();
  });
});
