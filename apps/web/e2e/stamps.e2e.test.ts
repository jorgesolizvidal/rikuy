/**
 * C2 · Paso 2 (ADR-057) in a real browser against the local stack: the stamps of the tourist
 * passport.
 *
 * - a visitor at the lookout of Demo Norte scans its stamp code and stamps «con ubicación»:
 *   only the code, a random passport id and «near» leave the phone, never the position; the
 *   stamp kept in the phone carries a signature the municipality's key verifies;
 * - far from the plaza, its stamp comes out «sin ubicación» (and counts): the circuit is
 *   complete; back at the plaza, the stamp becomes «con ubicación»; the circuit's page and the
 *   passport show what the phone has;
 * - without sharing the location the stamp counts too; a code of another municipality, a
 *   made-up code or a renewed one do not stamp; another site cannot stamp;
 * - in the panel, the owner sees and renews the codes (the printed one stops stamping, it is
 *   audited); an editor sees them without renewing; an analyst does not see them.
 */
import { request as httpRequest } from "node:http";

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
// Editor in Demo Norte, analyst in Demo Sur.
const EDITOR_EMAIL = "editor.ambos@example.test";
const MIRADOR = { lat: -17.3901, lng: -66.1502 };
const PLAZA = { lat: -17.3953, lng: -66.1556 };

const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
let browser: Browser;
let codes: Record<string, { contentId: string; code: string; version: number }> = {};

async function readCodes() {
  const rows = await db<{ slug: string; content_id: string; code: string; version: number }[]>`
    select i.slug, k.content_id, k.code, k.version
    from public.passport_stamp_codes k
    join public.content_items i on i.id = k.content_id
    where k.tenant_id = ${NORTE_ID}`;
  return Object.fromEntries(
    rows.map((row) => [
      row.slug,
      { contentId: row.content_id, code: row.code, version: row.version },
    ]),
  );
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

interface KeptStamp {
  placeId: string;
  at: number;
  located: boolean;
  signature: string;
}

async function keptPassport(page: Page) {
  return (await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem("rikuy:passport") ?? "null"),
  )) as { id: string; stamps: Record<string, KeptStamp> } | null;
}

async function validSignature(passportId: string, stamp: KeptStamp): Promise<boolean> {
  const [row] = await db<{ valid: boolean }[]>`
    select private.passport_stamp_valid(${NORTE_ID}, ${stamp.placeId}, ${passportId},
      ${stamp.at}, ${stamp.located}, ${stamp.signature}) as valid`;
  return row?.valid ?? false;
}

describe("the tourist passport's stamps (ADR-057)", () => {
  beforeAll(async () => {
    codes = await readCodes();
    browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    // The seed's codes stay as they were for the other suites.
    for (const [, original] of Object.entries(codes)) {
      await db`
        update public.passport_stamp_codes
        set code = ${original.code}, version = ${original.version},
            renewed_at = case when ${original.version} > 1 then renewed_at end,
            renewed_by = case when ${original.version} > 1 then renewed_by end
        where tenant_id = ${NORTE_ID} and content_id = ${original.contentId}`;
    }
    await db.end({ timeout: 5 });
  });

  it("stamps on the phone, with and without location, never sending the position", async () => {
    const mirador = codes["mirador-del-valle"];
    const plaza = codes["plaza-principal"];
    expect(mirador && plaza).toBeTruthy();
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      geolocation: { latitude: MIRADOR.lat, longitude: MIRADOR.lng, accuracy: 15 },
      permissions: ["geolocation"],
    });
    const page = await context.newPage();
    const sent: { url: string; body: string }[] = [];
    page.on("request", (request) => {
      sent.push({ url: request.url(), body: request.postData() ?? "" });
    });

    await page.goto(`${NORTE}/sello/${mirador!.code}`);
    await page.getByRole("heading", { level: 1, name: "Mirador del Valle" }).waitFor();
    expect(await page.locator('meta[name="robots"]').getAttribute("content")).toContain("noindex");
    expect(await page.locator('meta[name="referrer"]').getAttribute("content")).toBe("no-referrer");
    // Nothing is kept until the visitor stamps.
    expect(await keptPassport(page)).toBeNull();
    await accessible(page);

    await page.getByRole("button", { name: "Sellar con mi ubicación" }).click();
    await page.getByText("¡Sellado! Ya tienes el sello de «Mirador del Valle».").waitFor();
    await page.getByText(/^Con ubicación: tu teléfono confirmó/u).waitFor();
    await page.getByText("Ruta del valle: 1 de 2 sellos.").waitFor();
    await accessible(page);

    const stampRequest = sent.find((request) => request.url === `${NORTE}/sellar`);
    const body = JSON.parse(stampRequest?.body ?? "{}") as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["code", "located", "passport"]);
    expect(body).toMatchObject({ code: mirador!.code, located: true });
    // The position never leaves the phone: no request carries it.
    for (const request of sent) {
      expect(`${request.url} ${request.body}`).not.toMatch(/-17\.39|-66\.15/u);
    }

    let passport = await keptPassport(page);
    expect(passport?.id).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(passport?.id).toBe(body.passport);
    const miradorStamp = passport!.stamps[mirador!.contentId]!;
    expect(miradorStamp.located).toBe(true);
    expect(await validSignature(passport!.id, miradorStamp)).toBe(true);
    // Changed on the phone, it is no longer the municipality's.
    expect(await validSignature(passport!.id, { ...miradorStamp, located: false })).toBe(false);

    // Far from the plaza: the stamp counts, «sin ubicación».
    await context.setGeolocation({ latitude: -17.42, longitude: -66.2, accuracy: 15 });
    await page.goto(`${NORTE}/sello/${plaza!.code}`);
    await page.getByRole("button", { name: "Sellar con mi ubicación" }).click();
    await page.getByText("¡Sellado! Ya tienes el sello de «Plaza principal».").waitFor();
    await page
      .getByText(/^Sin ubicación: tu teléfono dice que estás a .+ de este lugar/u)
      .waitFor();
    await page
      .getByText(
        /¡completaste el circuito! Premio: Una postal del valle en la oficina de turismo\./u,
      )
      .waitFor();
    expect(await page.getByRole("link", { name: "Pedir mi premio" }).getAttribute("href")).toBe(
      "/pasaporte/ruta-del-valle#premio",
    );
    passport = await keptPassport(page);
    expect(passport!.stamps[plaza!.contentId]?.located).toBe(false);

    // The circuit's page and the passport show what this phone has.
    await page.goto(`${NORTE}/pasaporte/ruta-del-valle`);
    await page.getByText("¡Completaste el circuito!", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Pedir mi premio" }).waitFor();
    const stamps = await page.locator(".passport-stops .passport-stop-stamp").allInnerTexts();
    expect(stamps[0]).toMatch(/Sellado el .+ · sin ubicación/u);
    expect(stamps[1]).toMatch(/Sellado el .+ · con ubicación/u);
    await page.goto(`${NORTE}/pasaporte`);
    await page.getByText("Tienes 2 sellos en este teléfono.").waitFor();

    // Back at the plaza, the stamp becomes «con ubicación»; the first one stays otherwise.
    await context.setGeolocation({ latitude: PLAZA.lat, longitude: PLAZA.lng, accuracy: 15 });
    await page.goto(`${NORTE}/sello/${plaza!.code}`);
    await page
      .getByText(/^Ya tienes el sello de este lugar: sellado el .+ · sin ubicación\./u)
      .waitFor();
    await page.getByRole("button", { name: "Sellar de nuevo con mi ubicación" }).click();
    await page.getByText("Tu sello de «Plaza principal» ahora es con ubicación.").waitFor();
    passport = await keptPassport(page);
    expect(passport!.stamps[plaza!.contentId]?.located).toBe(true);
    expect(await validSignature(passport!.id, passport!.stamps[plaza!.contentId]!)).toBe(true);
    await page.goto(`${NORTE}/sello/${mirador!.code}`);
    await page
      .getByText(/^Ya tienes el sello de este lugar: sellado el .+ · con ubicación\./u)
      .waitFor();
    expect(await page.getByRole("button", { name: /Sellar/u }).count()).toBe(0);
    await context.close();
  });

  it("stamps without sharing the location, and only with a current code of the municipality", async () => {
    const mirador = codes["mirador-del-valle"]!;
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(`${NORTE}/sello/${mirador.code}`);
    await page.getByRole("button", { name: "Sellar sin compartir mi ubicación" }).click();
    await page.getByText("¡Sellado! Ya tienes el sello de «Mirador del Valle».").waitFor();
    await page.getByText(/^Sin ubicación: elegiste no compartirla/u).waitFor();
    expect(Object.values((await keptPassport(page))!.stamps)[0]?.located).toBe(false);

    // Another municipality's portal, a made-up code, the draft destination's code.
    await page.goto(`${SUR}/sello/${mirador.code}`);
    await page.getByRole("heading", { level: 1, name: "Este código no sella" }).waitFor();
    await page.goto(`${NORTE}/sello/AAAAAAAAAAAAAAAAAAAAAA`);
    await page.getByRole("heading", { level: 1, name: "Este código no sella" }).waitFor();
    await page.goto(`${NORTE}/sello/${codes["feria-de-los-domingos"]!.code}`);
    await page.getByRole("heading", { level: 1, name: "Este código no sella" }).waitFor();
    await page.goto(`${NORTE}/sello/no-es-un-codigo`);
    await page.getByRole("heading", { level: 1, name: "Este código no sella" }).waitFor();

    // Only a page of this same portal stamps; a malformed request or one with the position
    // itself is refused.
    const passportId = "AbCdEfGhIjKlMnOpQrSt_-";
    // node:http, which sends the portal's Host as given (fetch would replace it).
    const post = (origin: string, body: unknown) =>
      new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          {
            host: "127.0.0.1",
            port: PORT,
            path: "/sellar",
            method: "POST",
            headers: {
              host: `demo-norte.localhost:${PORT}`,
              origin,
              "content-type": "application/json",
            },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );
        request.on("error", reject);
        request.end(JSON.stringify(body));
      });
    expect(
      await post("https://otro.example", {
        code: mirador.code,
        passport: passportId,
        located: true,
      }),
    ).toBe(403);
    expect(
      await post(NORTE, { code: mirador.code, passport: passportId, lat: -17.39, lng: -66.15 }),
    ).toBe(400);
    expect(await post(NORTE, { code: mirador.code, passport: passportId, located: true })).toBe(
      200,
    );
    await context.close();
  });

  it("lets owners renew the codes; editors print them; analysts do not see them", async () => {
    const { context, page } = await signedIn(OWNER_EMAIL);
    await page.goto(`${ADMIN}/o/demo-norte/pasaporte`);
    await page.getByRole("heading", { level: 2, name: "Códigos de sello de cada lugar" }).waitFor();
    for (const title of ["Mirador del Valle", "Plaza principal", "Feria de los domingos"]) {
      expect(
        await page.getByRole("img", { name: `Código QR de sello de «${title}»` }).count(),
      ).toBe(1);
    }
    await page
      .getByText("El destino no está publicado: su código no sella hasta que lo esté.")
      .waitFor();
    expect(
      await page
        .locator(`a[download="sello-mirador-del-valle-${codes["mirador-del-valle"]!.version}.png"]`)
        .count(),
    ).toBe(1);
    await accessible(page);
    await page.setViewportSize({ width: 1280, height: 900 });

    const card = page.locator(".stamp-code", { hasText: "Mirador del Valle" });
    await card.getByRole("button", { name: "Renovar el QR" }).click();
    await card.getByText(/El que está impreso dejará de sellar/u).waitFor();
    await card.getByRole("button", { name: "Sí, renovar" }).click();
    await card.getByText("Se renovó: imprime el código nuevo. El anterior ya no sella.").waitFor();
    await card.getByText(/Código n\.º 2, renovado el/u).waitFor();

    const renewed = (await readCodes())["mirador-del-valle"]!;
    expect(renewed.version).toBe(2);
    expect(renewed.code).not.toBe(codes["mirador-del-valle"]!.code);
    const [audit] = await db<{ count: number }[]>`
      select count(*)::int as count from public.audit_events
      where tenant_id = ${NORTE_ID} and action = 'passport.stamp_code_renewed'`;
    expect(audit?.count).toBeGreaterThanOrEqual(1);

    const visitor = await browser.newPage();
    await visitor.goto(`${NORTE}/sello/${codes["mirador-del-valle"]!.code}`);
    await visitor.getByRole("heading", { level: 1, name: "Este código no sella" }).waitFor();
    await visitor.goto(`${NORTE}/sello/${renewed.code}`);
    await visitor.getByRole("heading", { level: 1, name: "Mirador del Valle" }).waitFor();
    await visitor.close();
    await context.close();

    const editor = await signedIn(EDITOR_EMAIL);
    await editor.page.goto(`${ADMIN}/o/demo-norte/pasaporte`);
    await editor.page
      .getByRole("heading", { level: 2, name: "Códigos de sello de cada lugar" })
      .waitFor();
    expect(await editor.page.getByRole("button", { name: "Renovar el QR" }).count()).toBe(0);
    // Analyst in Demo Sur: the codes are not for that role.
    await editor.page.goto(`${ADMIN}/o/demo-sur/pasaporte`);
    await editor.page.getByRole("heading", { level: 1, name: "Pasaporte turístico" }).waitFor();
    expect(
      await editor.page.getByRole("heading", { name: "Códigos de sello de cada lugar" }).count(),
    ).toBe(0);
    await editor.context.close();
  });
});
