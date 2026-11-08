/**
 * P6 · Paso 1 (ADR-043) in a real browser against the local stack (GoTrue with real TOTP):
 *
 * - a new administrator of Demo Sur is listed with «Pide verificación en dos pasos», cannot
 *   open the municipality (any page of it goes to /verificacion), sets up the app with the
 *   key shown, a wrong code is refused, and the right one opens the municipality;
 * - «Miembros» tells who set it up;
 * - the operator, with their own second factor, resets it after confirming, and the next
 *   sign-in of that person has to set it up again;
 * - an editor is never asked.
 *
 * The pages are checked with axe and for overflow at 390 and 1280 px.
 */
import { randomUUID } from "node:crypto";

import axe from "axe-core";
import { chromium, type Browser, type Page } from "playwright-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { totp } from "./support/second-factor";

const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = Number(process.env.RIKUY_PORT ?? 3000);
const ADMIN = `http://app.localhost:${PORT}`;
const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SUR = "5eed1000-0000-4000-8000-000000000002";
const OPERATOR_ID = "5eed0000-0000-4000-8000-000000000005";
const OPERATOR = "operador@rikuy.example.test";
const EDITOR = "editor.ambos@example.test";
const ADMIN_ID = randomUUID();
const ADMIN_EMAIL = `admin.${ADMIN_ID.slice(0, 8)}@demo-sur.example.test`;

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

/** Only the email code: the second factor is what these tests are about. */
async function signedIn(email: string): Promise<Page> {
  const page = await (
    await browser.newContext({ viewport: { width: 1280, height: 900 } })
  ).newPage();
  await page.goto(`${ADMIN}/login`);
  await page.getByLabel("Correo electrónico").fill(email);
  // GoTrue spaces emails to the same address.
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const since = Date.now();
  await page.getByRole("button", { name: "Recibir código" }).click();
  await page.getByLabel("Código de acceso").waitFor();
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

/** Sets up the app on the page that shows «Configurar…» and types its code. */
async function enroll(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Configurar la app de autenticación" }).click();
  const secret = (await page.locator("code.secret").innerText()).trim();
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/u);
  await page.getByLabel("Código de 6 dígitos").fill(totp(secret));
  await page.getByRole("button", { name: "Verificar" }).click();
  return secret;
}

describe("second factor of owners and admins (ADR-043)", () => {
  beforeAll(async () => {
    // A new administrator of Demo Sur, the way Auth stores a confirmed passwordless user.
    await db`
      insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
        confirmation_token, recovery_token, email_change, email_change_token_new,
        email_change_token_current, phone_change, phone_change_token, reauthentication_token)
      values ('00000000-0000-0000-0000-000000000000', ${ADMIN_ID}, 'authenticated', 'authenticated',
              ${ADMIN_EMAIL}, '', now(), '{"provider": "email", "providers": ["email"]}', '{}',
              now(), now(), '', '', '', '', '', '', '', '')`;
    await db`
      insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
      values (${ADMIN_ID}, ${ADMIN_ID}, ${ADMIN_ID}, 'email',
              ${db.json({ sub: ADMIN_ID, email: ADMIN_EMAIL, email_verified: true })}, now(), now(), now())`;
    await db`
      insert into public.memberships (tenant_id, user_id, role, status, accepted_at)
      values (${SUR}, ${ADMIN_ID}, 'admin', 'active', now())`;
    // The operator enrolls through the page below; a factor from an earlier local run would
    // have an unknown key.
    await db`delete from auth.mfa_factors where user_id = ${OPERATOR_ID}`;
    browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await db.end({ timeout: 5 });
  });

  it("an admin without a factor sets it up before opening their municipality", async () => {
    const page = await signedIn(ADMIN_EMAIL);
    await page.goto(`${ADMIN}/`);
    const card = page.locator(".org-card", { hasText: "Municipio Demo Sur" });
    await expect.poll(() => card.innerText()).toMatch(/Pide verificación en dos pasos/u);

    // Any page of the municipality goes to /verificacion and comes back to it.
    await page.goto(`${ADMIN}/o/demo-sur/miembros`);
    await page.waitForURL(/\/verificacion\?siguiente=%2Fo%2Fdemo-sur$/u);
    await page.goto(`${ADMIN}/`);
    await page.locator(".org-card", { hasText: "Municipio Demo Sur" }).click();
    await page.waitForURL(/\/verificacion\?siguiente=%2Fo%2Fdemo-sur$/u);
    expect(await page.getByRole("heading", { level: 1 }).innerText()).toBe(
      "Verificación en dos pasos",
    );
    expect(await page.locator("main").innerText()).toContain("Municipio Demo Sur");
    await accessible(page, "/verificacion (configurar)");

    await page.getByRole("button", { name: "Configurar la app de autenticación" }).click();
    await page.locator("code.secret").waitFor();
    await accessible(page, "/verificacion (QR)");
    await page.getByLabel("Código de 6 dígitos").fill("000000");
    await page.getByRole("button", { name: "Verificar" }).click();
    await expect
      .poll(() => page.locator("#mfa-error").innerText())
      .toMatch(/El código no es válido/u);
    const secret = (await page.locator("code.secret").innerText()).trim();
    await page.getByLabel("Código de 6 dígitos").fill(totp(secret));
    await page.getByRole("button", { name: "Verificar" }).click();
    await page.waitForURL(/\/o\/demo-sur$/u, { timeout: 15_000 });

    await page.goto(`${ADMIN}/o/demo-sur/miembros`);
    const row = page.locator("tr", { hasText: ADMIN_EMAIL });
    expect(await row.innerText()).toContain("Con verificación en dos pasos");
    await accessible(page, "/o/demo-sur/miembros");
  });

  it("the operator resets it, and the next sign-in sets it up again", async () => {
    const operator = await signedIn(OPERATOR);
    await operator.goto(`${ADMIN}/plataforma`);
    await enroll(operator);
    await operator.getByRole("heading", { level: 1, name: "Plataforma" }).waitFor();

    await operator.goto(`${ADMIN}/plataforma/segundo-factor`);
    await accessible(operator, "/plataforma/segundo-factor");
    const status = operator.locator("#reset-status");

    // Someone who is not an owner or admin anywhere is not reset.
    await operator.getByLabel("Correo de la persona").fill(EDITOR);
    await operator
      .getByRole("button", { name: "Restablecer la verificación en dos pasos" })
      .click();
    await operator.getByRole("button", { name: `Confirmar: restablecer a ${EDITOR}` }).click();
    await expect.poll(() => status.innerText()).toMatch(/no es propietaria ni administradora/u);

    await operator.getByLabel("Correo de la persona").fill(ADMIN_EMAIL);
    await operator
      .getByRole("button", { name: "Restablecer la verificación en dos pasos" })
      .click();
    // Nothing happens until the confirmation naming the person.
    expect(
      await db`select 1 from public.audit_events where action = 'membership.second_factor_reset' and diff ->> 'user_id' = ${ADMIN_ID}`,
    ).toHaveLength(0);
    await operator.getByRole("button", { name: `Confirmar: restablecer a ${ADMIN_EMAIL}` }).click();
    await expect.poll(() => status.innerText()).toMatch(/^Listo: /u);
    const [audit] = await db`
      select actor_id, tenant_id from public.audit_events
      where action = 'membership.second_factor_reset' and diff ->> 'user_id' = ${ADMIN_ID}`;
    expect(audit).toEqual({ actor_id: OPERATOR_ID, tenant_id: SUR });

    const again = await signedIn(ADMIN_EMAIL);
    await again.goto(`${ADMIN}/o/demo-sur`);
    await again.waitForURL(/\/verificacion\?siguiente=%2Fo%2Fdemo-sur$/u);
    await again.getByRole("button", { name: "Configurar la app de autenticación" }).waitFor();
  });

  it("an editor is never asked", async () => {
    const page = await signedIn(EDITOR);
    await page.goto(`${ADMIN}/o/demo-norte`);
    expect(new URL(page.url()).pathname).toBe("/o/demo-norte");
    await page.goto(`${ADMIN}/verificacion?siguiente=%2Fo%2Fdemo-norte`);
    expect(new URL(page.url()).pathname).toBe("/o/demo-norte");
  });
});
