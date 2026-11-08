/**
 * P6 · Paso 3 (ADR-045) in a real browser against the local stack, with the simulated model:
 *
 * - the operator (with a second factor), owner of two demos, starts a run of «Evaluar el
 *   asistente»: demo A is Demo Sur, demo B is Demo Norte (it has the plaza the trap data
 *   needs);
 * - prepares the trap data in demo B and retires it: the portal never shows the draft, and
 *   after retiring, the ended event's page is gone;
 * - runs a batch: five results with their verdicts, recorded in eval_results with a cost
 *   (none for the simulated model) and the report says «incompleto»;
 * - «Evaluar el Copilot»: a batch of two cases, and no proposal left pending;
 * - both pages pass axe and do not overflow at 390 and 1280 px.
 *
 * The seed's demos become commercial demos only during this test.
 */
import axe from "axe-core";
import { chromium, type Browser, type Page } from "playwright-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { totp } from "./support/second-factor";

const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = Number(process.env.RIKUY_PORT ?? 3000);
const ADMIN = `http://app.localhost:${PORT}`;
const NORTE_PORTAL = `http://demo-norte.localhost:${PORT}`;
const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const NORTE = "5eed1000-0000-4000-8000-000000000001";
const SUR = "5eed1000-0000-4000-8000-000000000002";
const OPERATOR_ID = "5eed0000-0000-4000-8000-000000000005";
const OPERATOR = "operador@rikuy.example.test";

const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
let browser: Browser;
let page: Page;

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

async function accessible(label: string) {
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

describe("evaluation with the model (ADR-045)", () => {
  beforeAll(async () => {
    await db`delete from auth.mfa_factors where user_id = ${OPERATOR_ID}`;
    await db`update public.tenants set is_demo = true where id in (${NORTE}, ${SUR})`;
    await db`
      insert into public.memberships (tenant_id, user_id, role, status, accepted_at)
      values (${NORTE}, ${OPERATOR_ID}, 'owner', 'active', now()),
             (${SUR}, ${OPERATOR_ID}, 'owner', 'active', now())
      on conflict (tenant_id, user_id) do update
        set role = 'owner', status = 'active', revoked_at = null, accepted_at = now()
    `;
    browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
    });
    page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
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
  }, 90_000);

  afterAll(async () => {
    await db`
      update public.memberships set status = 'revoked', revoked_at = now()
      where user_id = ${OPERATOR_ID} and tenant_id in (${NORTE}, ${SUR})
    `;
    await db`update public.tenants set is_demo = false where id in (${NORTE}, ${SUR})`;
    await browser?.close();
    await db.end({ timeout: 5 });
  });

  it("runs the assistant against two demos, with the trap data prepared and retired", async () => {
    await page.getByRole("link", { name: "Evaluar el asistente" }).click();
    await page.waitForURL(/\/plataforma\/asistente$/u);
    await page
      .getByLabel("Demo A (la que ven los clientes)")
      .selectOption({ label: "Municipio Demo Sur" });
    await page
      .getByLabel("Demo B (datos de prueba)")
      .selectOption({ label: "Municipio Demo Norte" });
    await page.getByRole("button", { name: "Empezar una corrida" }).click();
    await page.waitForURL(/corrida=[0-9a-f-]{36}/u);
    const runId = new URL(page.url()).searchParams.get("corrida") ?? "";

    // The trap data, in demo B only.
    await page.getByRole("button", { name: "Preparar los datos de prueba" }).click();
    await page.getByText("Listos. El asistente los lee").waitFor({ timeout: 30_000 });
    await expect
      .poll(
        async () =>
          db`select slug, kind::text, published_revision_id is not null as published
             from public.content_items where tenant_id = ${NORTE} and slug like 'prueba-eval-%'
             order by slug`,
        { timeout: 10_000 },
      )
      .toEqual([
        { slug: "prueba-eval-feria-del-durazno", kind: "event", published: true },
        { slug: "prueba-eval-indicaciones", kind: "knowledge", published: true },
        { slug: "prueba-eval-laguna-escondida", kind: "destination", published: false },
        { slug: "prueba-eval-otra-historia", kind: "knowledge", published: true },
      ]);
    expect(
      await db`select 1 from public.content_items where tenant_id = ${SUR} and slug like 'prueba-eval-%'`,
    ).toHaveLength(0);
    const draft = await fetch(`${NORTE_PORTAL}/destinos/prueba-eval-laguna-escondida`);
    expect(draft.status, "a draft never reaches the portal").toBe(404);

    // A batch: five cases, graded and recorded.
    await page.getByRole("button", { name: /^Correr la siguiente tanda/u }).click();
    await page.getByText(/^Listo: \d de 5 bien\./u).waitFor({ timeout: 90_000 });
    const rows = await db<
      { case_id: string; pass: boolean | null; estimated_cost_usd: string | null }[]
    >`
      select case_id, pass, estimated_cost_usd from public.eval_results where run_id = ${runId}
      order by case_id`;
    expect(rows.map((row) => row.case_id)).toEqual(["G01", "G02", "G03", "G04", "G05"]);
    expect(
      rows.every((row) => row.estimated_cost_usd === null),
      "no price for the simulated model",
    ).toBe(true);
    await page.getByRole("heading", { name: "Informe: incompleto" }).waitFor();
    await expect.poll(() => page.locator(".eval-table tbody tr").count()).toBe(5);
    await accessible("/plataforma/asistente");

    // Retiring takes the trap data back from the assistant and the portal.
    await page.getByRole("button", { name: "Retirar los datos de prueba" }).click();
    await page.getByText("Retirados: el asistente y el portal ya no los ven.").waitFor();
    expect(
      await db`select slug from public.content_items where tenant_id = ${NORTE}
               and slug like 'prueba-eval-%' and published_revision_id is not null`,
    ).toHaveLength(0);
    await expect
      .poll(
        async () => (await fetch(`${NORTE_PORTAL}/agenda/prueba-eval-feria-del-durazno`)).status,
        {
          timeout: 15_000,
        },
      )
      .toBe(404);
  });

  it("runs the Copilot and leaves no proposal behind", async () => {
    await page.goto(`${ADMIN}/plataforma/copilot`);
    await page
      .getByLabel("Demo A (la que ven los clientes)")
      .selectOption({ label: "Municipio Demo Sur" });
    await page
      .getByLabel("Demo B (datos de prueba)")
      .selectOption({ label: "Municipio Demo Norte" });
    await page.getByRole("button", { name: "Empezar una corrida" }).click();
    await page.waitForURL(/\/plataforma\/copilot\?corrida=/u);
    const runId = new URL(page.url()).searchParams.get("corrida") ?? "";
    await page.getByRole("button", { name: /^Correr la siguiente tanda/u }).click();
    await page.getByText(/^Listo: \d de 2 bien\./u).waitFor({ timeout: 90_000 });
    expect(
      (
        await db`select case_id from public.eval_results where run_id = ${runId} order by case_id`
      ).map((row) => row.case_id),
    ).toEqual(["C01", "C02"]);
    expect(
      await db`select 1 from public.copilot_proposals where created_by = ${OPERATOR_ID} and status = 'pending'`,
    ).toHaveLength(0);
    await accessible("/plataforma/copilot");
  });
});
