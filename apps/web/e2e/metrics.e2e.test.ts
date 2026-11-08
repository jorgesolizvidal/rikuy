/**
 * P6 · Paso 2 (ADR-044) in a real browser against the local stack:
 *
 * - a REAL server error: the function /mapa reads is renamed for a moment, the portal shows
 *   its error page with the reference code, and the error is recorded with the same request
 *   ID the response carried (X-Rikuy-Request-Id), its municipality and its route pattern;
 * - a measured route is summed up in its hour;
 * - the operator (with a second factor) sees it in «Métricas por municipio», finds the error
 *   by its reference code, and runs «Revisar ahora»; both pages pass axe and do not overflow
 *   at 390 and 1280 px.
 */
import axe from "axe-core";
import { chromium, type Browser, type Page } from "playwright-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { totp } from "./support/second-factor";

const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = Number(process.env.RIKUY_PORT ?? 3000);
const ADMIN = `http://app.localhost:${PORT}`;
const SUR_PORTAL = `http://demo-sur.localhost:${PORT}`;
const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SUR = "5eed1000-0000-4000-8000-000000000002";
const OPERATOR_ID = "5eed0000-0000-4000-8000-000000000005";
const OPERATOR = "operador@rikuy.example.test";

const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
let browser: Browser;
let failure: { requestId: string; digest: string } | null = null;

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

describe("metrics per municipality (ADR-044)", () => {
  beforeAll(async () => {
    // The operator enrolls through /plataforma below; an earlier factor has an unknown key.
    await db`delete from auth.mfa_factors where user_id = ${OPERATOR_ID}`;
    browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
    });
  }, 60_000);

  afterAll(async () => {
    await db`
      do $$ begin
        if to_regprocedure('public.portal_map_extent_off(uuid)') is not null then
          alter function public.portal_map_extent_off(uuid) rename to portal_map_extent;
        end if;
      end $$`;
    await browser?.close();
    await db.end({ timeout: 5 });
  });

  it("records a real server error with the request ID the response carried", async () => {
    const page = await (
      await browser.newContext({ viewport: { width: 390, height: 800 } })
    ).newPage();
    await db`alter function public.portal_map_extent(uuid) rename to portal_map_extent_off`;
    try {
      // The map reader keeps its extent ~30 s per instance: wait until the page really fails.
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        const response = await page.goto(`${SUR_PORTAL}/mapa`);
        if (response?.status() === 500) {
          const requestId = response.headers()["x-rikuy-request-id"] ?? "";
          await page.getByText("Código de referencia").waitFor();
          const digest = (await page.locator(".portal-legal-note code").innerText()).trim();
          failure = { requestId, digest };
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    } finally {
      await db`alter function public.portal_map_extent_off(uuid) rename to portal_map_extent`;
      // PostgREST reloads its schema on DDL; say it explicitly so later steps see /mapa again.
      await db`notify pgrst, 'reload schema'`;
    }
    if (failure === null) throw new Error("/mapa never failed");
    expect(failure.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await page.getByRole("heading", { level: 1 }).innerText()).toBe(
      "No pudimos cargar esta página",
    );

    const { requestId, digest } = failure;
    await expect
      .poll(
        async () =>
          db`
            select surface, tenant_id, route, digest from public.request_errors
            where request_id = ${requestId}::uuid`,
        { timeout: 10_000 },
      )
      .toEqual([{ surface: "portal", tenant_id: SUR, route: "/portal/[host]/mapa", digest }]);
  });

  it("sums up a measured route in its hour", async () => {
    const before = await db<{ requests: number }[]>`
      select coalesce(sum(requests), 0)::int as requests from public.route_latency_hourly
      where tenant_id = ${SUR} and route = 'map_places'`;
    const page = await (await browser.newContext()).newPage();
    const response = await page.goto(
      `${SUR_PORTAL}/mapa/lugares?area=-66.5,-17.8,-65.8,-17.1&capas=destinos,eventos`,
    );
    expect(response?.status()).toBe(200);
    await expect
      .poll(
        async () =>
          (
            await db<{ requests: number }[]>`
              select coalesce(sum(requests), 0)::int as requests from public.route_latency_hourly
              where tenant_id = ${SUR} and route = 'map_places'`
          )[0]?.requests,
        { timeout: 10_000 },
      )
      .toBe((before[0]?.requests ?? 0) + 1);
  });

  it("the operator finds it by its code and checks what is published", async () => {
    if (failure === null) throw new Error("needs the recorded error");
    const page = await (
      await browser.newContext({ viewport: { width: 1280, height: 900 } })
    ).newPage();
    await page.goto(`${ADMIN}/login`);
    await page.getByLabel("Correo electrónico").fill(OPERATOR);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const since = Date.now();
    await page.getByRole("button", { name: "Recibir código" }).click();
    await page.getByLabel("Código de acceso").fill(await emailCode(OPERATOR, since));
    await page.getByRole("button", { name: "Entrar" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });
    await page.goto(`${ADMIN}/plataforma`);
    await page.getByRole("button", { name: "Configurar la app de autenticación" }).click();
    const secret = (await page.locator("code.secret").innerText()).trim();
    await page.getByLabel("Código de 6 dígitos").fill(totp(secret));
    await page.getByRole("button", { name: "Verificar" }).click();
    await page.getByRole("heading", { level: 1, name: "Plataforma" }).waitFor();

    await page.getByRole("link", { name: "Métricas por municipio" }).click();
    await page.waitForURL(/\/plataforma\/metricas$/u);
    const row = page.locator("tr", { hasText: "Municipio Demo Sur" });
    expect(Number((await row.locator("td").first().innerText()).trim())).toBeGreaterThanOrEqual(1);
    expect(await page.locator(".metrics-sources").first().innerText()).toMatch(
      /Fuente: .*Período: /u,
    );
    await accessible(page, "/plataforma/metricas");

    await row.getByRole("link", { name: "Municipio Demo Sur" }).click();
    await page.waitForURL(/\/plataforma\/metricas\/demo-sur$/u);
    await page.getByLabel("ID de petición o código de referencia").fill(failure.digest);
    await page.getByRole("button", { name: "Buscar" }).click();
    await page.waitForURL(new RegExp(`buscar=${failure.digest}`, "u"));
    const errors = page.locator("section", { hasText: "Errores del servidor" }).locator("tbody tr");
    await expect.poll(() => errors.count()).toBeGreaterThanOrEqual(1);
    expect(await errors.first().innerText()).toContain(failure.requestId);

    await page.getByRole("button", { name: "Revisar ahora" }).click();
    await page.getByText("Revisado: el resultado de arriba es el de ahora.").waitFor();
    // The page refreshes itself with the new result.
    await expect
      .poll(() => page.locator("#integridad + p").innerText(), { timeout: 10_000 })
      .toMatch(/^Revisado .*a pedido/u);
    await accessible(page, "/plataforma/metricas/demo-sur");
  });
});
