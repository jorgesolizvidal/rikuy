/**
 * C2 · Paso 3 (ADR-058) in a real browser against the local stack: the prize of the tourist
 * passport.
 *
 * - a visitor stamps both stops of Demo Norte's «Ruta del valle» without location, asks for
 *   the prize and gets a voucher (kept in the phone; asking again gives the same one);
 * - another phone with those stamps copied gets nothing;
 * - the shop cannot redeem before the municipality sets the shop's key; the owner sets it
 *   in the panel (audited, only a hash kept; an editor sees the section without the form);
 * - the shop checks the voucher (wrong key refused), redeems it once, and the visitor's page
 *   says the prize was received; axe and no overflow at 390 and 1280 px.
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
const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const NORTE_ID = "5eed1000-0000-4000-8000-000000000001";
const CIRCUIT_ID = "5eed4600-0000-4000-8000-000000000001";
const OWNER_EMAIL = "owner@demo-norte.example.test";
// Editor in Demo Norte.
const EDITOR_EMAIL = "editor.ambos@example.test";
const PIN = "4826";

const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
let browser: Browser;
let codes: Record<string, string> = {};

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
  await page.setViewportSize({ width: 390, height: 844 });
}

async function keptPassport(page: Page) {
  return (await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem("rikuy:passport") ?? "null"),
  )) as {
    id: string;
    stamps: Record<string, unknown>;
    vouchers?: Record<string, { code: string; redeemedAt: string | null }>;
  } | null;
}

async function cleanUp() {
  await db`delete from public.passport_vouchers where tenant_id = ${NORTE_ID}`;
  await db`delete from private.passport_redeem_failures where tenant_id = ${NORTE_ID}`;
  await db`update public.passport_circuits set redeem_pin_hash = null, redeem_pin_set_at = null
           where id = ${CIRCUIT_ID}`;
}

describe("the tourist passport's prize (ADR-058)", () => {
  beforeAll(async () => {
    await cleanUp();
    const rows = await db<{ slug: string; code: string }[]>`
      select i.slug, k.code from public.passport_stamp_codes k
      join public.content_items i on i.id = k.content_id
      where k.tenant_id = ${NORTE_ID}`;
    codes = Object.fromEntries(rows.map((row) => [row.slug, row.code]));
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

  it("gives a voucher to a complete passport, and redeems it once at the shop", async () => {
    // The visitor stamps both stops, without location.
    const visitor = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const phone = await visitor.newPage();
    for (const slug of ["mirador-del-valle", "plaza-principal"]) {
      await phone.goto(`${NORTE}/sello/${codes[slug]}`);
      await phone.getByRole("button", { name: "Sellar sin compartir mi ubicación" }).click();
      await phone.getByText(/^¡Sellado!/u).waitFor();
    }
    await phone.getByRole("link", { name: "Pedir mi premio" }).click();
    await phone.waitForURL(`${NORTE}/pasaporte/ruta-del-valle#premio`);
    await phone.getByText("¡Completaste el circuito!").waitFor();
    await phone.getByRole("button", { name: "Pedir mi premio" }).click();
    await phone.getByRole("heading", { name: "Tu comprobante" }).waitFor();
    const shown = (await phone.locator(".voucher-code").innerText()).replace(/^Código:\s*/u, "");
    expect(shown).toMatch(
      /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/u,
    );
    await phone
      .getByText(/Una postal del valle en la oficina de turismo/u)
      .first()
      .waitFor();
    await phone
      .getByText(/Vale hasta el .+ · 2 sellos, 0 con ubicación\. Se canjea una sola vez\./u)
      .waitFor();
    await accessible(phone);

    const code = shown.replace("-", "");
    expect((await keptPassport(phone))?.vouchers?.["ruta-del-valle"]?.code).toBe(code);
    const [row] = await db<{ code: string; stamps_located: number; redeemed_at: Date | null }[]>`
      select code, stamps_located, redeemed_at from public.passport_vouchers where tenant_id = ${NORTE_ID}`;
    expect(row).toMatchObject({ code, stamps_located: 0, redeemed_at: null });

    // Opening the page again gives the same voucher.
    await phone.reload();
    await phone.getByRole("heading", { name: "Tu comprobante" }).waitFor();
    expect(await phone.locator(".voucher-code").innerText()).toContain(shown);
    const [count] = await db<{ n: number }[]>`
      select count(*)::int as n from public.passport_vouchers where tenant_id = ${NORTE_ID}`;
    expect(count?.n).toBe(1);

    // Another phone with those stamps copied gets nothing.
    const copied = await keptPassport(phone);
    const other = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const otherPhone = await other.newPage();
    await otherPhone.goto(`${NORTE}/pasaporte`);
    await otherPhone.evaluate(
      (stamps) =>
        window.localStorage.setItem(
          "rikuy:passport",
          JSON.stringify({ v: 1, id: "OtroTelefonoCopiado_12", stamps }),
        ),
      copied!.stamps,
    );
    await otherPhone.goto(`${NORTE}/pasaporte/ruta-del-valle`);
    await otherPhone.getByRole("button", { name: "Pedir mi premio" }).click();
    await otherPhone.getByText("Te faltan 2 sellos de este circuito.").waitFor();
    await other.close();

    // The shop: no key yet.
    const shop = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const counter = await shop.newPage();
    await counter.goto(`${NORTE}/canje`);
    expect(await counter.locator('meta[name="robots"]').getAttribute("content")).toContain(
      "noindex",
    );
    await counter.getByLabel("Código del comprobante").fill(shown.toLowerCase());
    await counter.getByLabel("Clave del local").fill(PIN);
    await counter.getByRole("button", { name: "Comprobar" }).click();
    await counter
      .getByText(
        "El circuito «Ruta del valle» todavía no tiene clave del local: pídesela al municipio.",
      )
      .waitFor();

    // The owner sets the shop's key.
    const owner = await signedIn(OWNER_EMAIL);
    await owner.page.goto(`${ADMIN}/o/demo-norte/pasaporte/${CIRCUIT_ID}`);
    await owner.page.getByRole("heading", { name: "Premio y canje" }).waitFor();
    await owner.page
      .getByText(
        "Este circuito todavía no tiene clave del local: sin ella, los comprobantes no se pueden canjear.",
      )
      .waitFor();
    expect(await owner.page.getByRole("link", { name: `${NORTE}/canje` }).count()).toBe(1);
    // Plain text so the person sees the key and no password manager fills it.
    expect(await owner.page.getByLabel("Clave del local").getAttribute("type")).toBe("text");
    await owner.page.getByLabel("Clave del local").fill("12");
    await owner.page.getByRole("button", { name: "Guardar la clave" }).click();
    expect(await owner.page.getByText("Se guardó la clave").count()).toBe(0);
    await owner.page.getByLabel("Clave del local").fill(PIN);
    await owner.page.getByRole("button", { name: "Guardar la clave" }).click();
    await owner.page
      .getByText(`Se guardó la clave ${PIN}. Anótala y dásela al local que entrega el premio.`)
      .waitFor();
    await owner.page.getByText(/^Clave del local guardada el /u).waitFor();
    await accessible(owner.page);
    const [pin] = await db<{ hash: string }[]>`
      select redeem_pin_hash as hash from public.passport_circuits where id = ${CIRCUIT_ID}`;
    expect(pin?.hash).toMatch(/^\$2a\$/u);
    expect(pin?.hash).not.toContain(PIN);
    await owner.context.close();

    // The shop checks with a wrong key, then the right one, and redeems once.
    await counter.getByLabel("Clave del local").fill("0000");
    await counter.getByRole("button", { name: "Comprobar" }).click();
    await counter.getByText("El código o la clave del local no son correctos.").waitFor();
    expect(await counter.getByLabel("Clave del local").getAttribute("type")).toBe("text");
    // A failing server is not reported as a wrong key.
    await counter.route("**/canje/verificar", (route) =>
      route.fulfill({ status: 500, contentType: "text/html", body: "<h1>Error</h1>" }),
    );
    await counter.getByLabel("Clave del local").fill(PIN);
    await counter.getByRole("button", { name: "Comprobar" }).click();
    await counter
      .getByText("No pudimos comprobarlo ahora. Revisa la conexión e intenta de nuevo.")
      .waitFor();
    await counter.unroute("**/canje/verificar");
    await counter.getByLabel("Clave del local").fill(PIN);
    await counter.getByRole("button", { name: "Comprobar" }).click();
    await counter.getByRole("heading", { name: "Comprobante válido" }).waitFor();
    await counter.getByText("2, 0 con ubicación").waitFor();
    await accessible(counter);
    const [checked] = await db<{ redeemed_at: Date | null }[]>`
      select redeemed_at from public.passport_vouchers where code = ${code}`;
    expect(checked?.redeemed_at).toBeNull();
    await counter
      .getByRole("button", { name: "Marcar como canjeado y entregar el premio" })
      .click();
    await counter.getByRole("heading", { name: "¡Canjeado! Entrega el premio." }).waitFor();
    const [redeemed] = await db<{ redeemed_at: Date | null }[]>`
      select redeemed_at from public.passport_vouchers where code = ${code}`;
    expect(redeemed?.redeemed_at).not.toBeNull();
    await counter.getByRole("button", { name: "Revisar otro comprobante" }).click();
    await counter.getByLabel("Código del comprobante").fill(shown);
    await counter.getByRole("button", { name: "Comprobar" }).click();
    await counter.getByRole("heading", { name: "Este comprobante ya se canjeó" }).waitFor();
    await shop.close();

    const [audit] = await db<{ n: number }[]>`
      select count(*)::int as n from public.audit_events
      where tenant_id = ${NORTE_ID} and action in ('passport.redeem_pin_set', 'passport.voucher_redeemed')`;
    expect(audit?.n).toBeGreaterThanOrEqual(2);

    // The visitor's page says the prize was received; asking again gives no second prize.
    await phone.reload();
    await phone.getByRole("heading", { name: "Premio recibido" }).waitFor();
    expect((await keptPassport(phone))?.vouchers?.["ruta-del-valle"]?.redeemedAt).not.toBeNull();
    await visitor.close();
  });

  it("shows an editor the prize without the shop's key form", async () => {
    const { context, page } = await signedIn(EDITOR_EMAIL);
    await page.goto(`${ADMIN}/o/demo-norte/pasaporte/${CIRCUIT_ID}`);
    await page.getByRole("heading", { name: "Premio y canje" }).waitFor();
    expect(await page.getByLabel(/Clave (nueva )?del local/u).count()).toBe(0);
    await context.close();
  });
});
