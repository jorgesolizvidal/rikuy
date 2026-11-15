/**
 * C3 · Paso 5 (ADR-064) in a real browser against the local stack: the passport's pages with
 * the design system.
 *
 * - a circuit's page: the progress ring, the prize with «Te faltan N sellos», every stop as a
 *   round seal in the suggested order, the next one marked and none locked; after stamping the
 *   lookout its seal is inked with the date and the plaza becomes the next;
 * - the stamp page shows the place's seal, inked right after stamping, and each circuit's ring;
 * - «Escanear el código del lugar»: with the browser's barcode reader (simulated: Chrome on
 *   Linux has none) a code of another site is reported and never followed, a stamp of this
 *   portal opens its page, and closing the dialog stops the camera; without a reader the page
 *   says to use the phone's camera;
 * - axe without critical or serious findings and no overflow at 390 and 1280 px.
 */
import axe from "axe-core";
import { chromium, type Browser, type Page } from "playwright-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = Number(process.env.RIKUY_PORT ?? 3000);
const NORTE = `http://demo-norte.localhost:${PORT}`;
const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const NORTE_ID = "5eed1000-0000-4000-8000-000000000001";

const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
let browser: Browser;
let codes: Record<string, string> = {};

/** What the simulated barcode reader «sees»: set from the test with `window.__qr`. */
const FAKE_READER = `
  window.__qr = null;
  window.BarcodeDetector = class {
    static async getSupportedFormats() { return ["qr_code"]; }
    async detect() { return window.__qr ? [{ rawValue: window.__qr }] : []; }
  };
`;

async function phone(width = 390, reader = false): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width, height: 844 },
    permissions: ["camera"],
  });
  if (reader) await context.addInitScript(FAKE_READER);
  return context.newPage();
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
  await page.setViewportSize({ width: 390, height: 844 });
}

async function stops(page: Page) {
  return page.locator(".passport-stop").evaluateAll((items) =>
    items.map((item) => ({
      title: item.querySelector(".passport-stop-title")?.textContent ?? "",
      state: item.getAttribute("data-state"),
      stamp: item.querySelector(".passport-stop-stamp")?.textContent ?? "",
    })),
  );
}

describe("the passport's pages with the design system (ADR-064)", () => {
  beforeAll(async () => {
    browser = await chromium.launch({
      executablePath: CHROME,
      args: [
        "--host-resolver-rules=MAP *.localhost 127.0.0.1",
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    });
    const rows = await db<{ slug: string; code: string }[]>`
      select i.slug, k.code
      from public.passport_stamp_codes k
      join public.content_items i on i.id = k.content_id
      where k.tenant_id = ${NORTE_ID}`;
    codes = Object.fromEntries(rows.map((row) => [row.slug, row.code]));
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await db.end({ timeout: 5 });
  });

  it("a circuit's stops are seals: the next one marked, none locked; stamping inks it", async () => {
    const page = await phone();
    await page.goto(`${NORTE}/pasaporte/ruta-del-valle`);
    await page.getByText("Todavía no tienes sellos de este circuito en este teléfono.").waitFor();
    expect(await stops(page)).toEqual([
      { title: "Plaza principal", state: "next", stamp: "Falta el sello" },
      { title: "Mirador del Valle", state: "missing", stamp: "Falta el sello" },
    ]);
    expect(await page.locator(".passport-stop-next").allInnerTexts()).toEqual([
      "Siguiente sugerida",
    ]);
    expect(await page.locator(".passport-panel").innerText()).toMatch(/Te faltan 2 sellos/u);
    // Every stop links to its page: nothing is locked.
    expect(
      await page
        .locator(".passport-stop-title")
        .evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
    ).toEqual(["/destinos/plaza-principal", "/destinos/mirador-del-valle"]);
    // The route's map waits for the visitor; the full map is one link away.
    expect(await page.getByRole("button", { name: "Mostrar el recorrido" }).count()).toBe(1);
    await accessible(page, "circuit before stamping");

    // The lookout first (any order counts).
    await page.goto(`${NORTE}/sello/${codes["mirador-del-valle"]}`);
    expect(await page.locator(".stamp-seal").getAttribute("data-state")).toBe("missing");
    await page.getByRole("button", { name: /^Sellar sin compartir|^Sellar$/u }).click();
    await page.getByText(/¡Sellado!/u).waitFor();
    const seal = page.locator(".stamp-seal-box .stamp-seal");
    expect(await seal.getAttribute("data-state")).toBe("stamped");
    expect(await seal.getAttribute("data-animate")).toBe("true");
    expect(await seal.locator(".stamp-seal-date").textContent()).toMatch(/^\d{1,2} [A-Z]{3}/u);
    expect(await page.locator(".stamp-circuits .progress-ring-text").allTextContents()).toEqual([
      "1/2",
    ]);
    await accessible(page, "stamp page after stamping");

    await page.goto(`${NORTE}/pasaporte/ruta-del-valle`);
    await page.getByText("Tienes 1 de 2 sellos en este teléfono.").waitFor();
    const after = await stops(page);
    expect(after.map((stop) => stop.state)).toEqual(["next", "stamped"]);
    expect(after[1]?.stamp).toMatch(/Sellado el .+ · sin ubicación/u);
    expect(await page.locator(".passport-panel").innerText()).toMatch(/Te falta 1 sello/u);
    expect(await page.locator(".passport-panel .progress-ring-text").textContent()).toBe("1/2");
    await accessible(page, "circuit with one stamp");

    // The passport's list shows the same seals in a row and the ring.
    await page.goto(`${NORTE}/pasaporte`);
    await page.getByText("Tienes 1 sello en este teléfono.").waitFor();
    expect(
      await page
        .locator(".passport-seal-row .stamp-seal")
        .evaluateAll((seals) => seals.map((seal) => seal.getAttribute("data-state"))),
    ).toEqual(["missing", "stamped"]);
    await accessible(page, "passport page");
    await page.context().close();
  });

  it("the scanner opens only a stamp of this portal and stops the camera on close", async () => {
    const page = await phone(390, true);
    await page.goto(`${NORTE}/pasaporte`);
    await page.getByRole("button", { name: "Escanear el código del lugar" }).click();
    const dialog = page.getByRole("dialog", { name: "Escanear el código del lugar" });
    await dialog.getByText("Apunta al código del pasaporte que está en el lugar.").waitFor();
    expect(
      await page.evaluate(() => {
        const video = document.querySelector<HTMLVideoElement>(".qr-scanner video");
        const stream = video?.srcObject as MediaStream | null;
        return stream?.getVideoTracks().map((track) => track.readyState) ?? [];
      }),
    ).toEqual(["live"]);
    await accessible(page, "scanner open");

    // Another site, even with a stamp's path: reported, never followed.
    await page.evaluate((url) => {
      (window as unknown as { __qr: string }).__qr = url;
    }, `https://otro-sitio.example/sello/${codes["mirador-del-valle"]}`);
    await dialog.getByText("Ese código no es un sello del pasaporte de este portal.").waitFor();
    expect(page.url()).toBe(`${NORTE}/pasaporte`);

    // Closing stops the camera.
    await dialog.getByRole("button", { name: "Cerrar" }).click();
    expect(
      await page.evaluate(
        () => document.querySelector<HTMLVideoElement>(".qr-scanner video")?.srcObject ?? null,
      ),
    ).toBeNull();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.textContent?.trim() ?? ""))
      .toBe("Escanear el código del lugar");

    // A stamp of this portal opens its page.
    await page.getByRole("button", { name: "Escanear el código del lugar" }).click();
    await page.evaluate((url) => {
      (window as unknown as { __qr: string }).__qr = url;
    }, `${NORTE}/sello/${codes["plaza-principal"]}?qr=1`);
    await page.waitForURL(`${NORTE}/sello/${codes["plaza-principal"]}`);
    await page.getByRole("heading", { level: 1, name: "Plaza principal" }).waitFor();
    await page.context().close();
  });

  it("without the browser's barcode reader, the page says to use the phone's camera", async () => {
    const page = await phone();
    await page.goto(`${NORTE}/pasaporte/ruta-del-valle`);
    await page.getByRole("button", { name: "Escanear el código del lugar" }).click();
    const dialog = page.getByRole("dialog", { name: "Escanear el código del lugar" });
    await dialog.getByText(/Abre la cámara de tu teléfono y apunta al código/u).waitFor();
    expect(await dialog.locator(".qr-scanner-view").isVisible()).toBe(false);
    await page.keyboard.press("Escape");
    await expect.poll(() => dialog.count()).toBe(0);
    await page.context().close();
  });
});
