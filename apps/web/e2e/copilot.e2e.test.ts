/**
 * The staff's Copilot in a real browser (P5 · Paso 7, ADR-042), on a destination created
 * here in Demo Sur with the same RPCs as the panel, against the production build with the
 * simulated model:
 *
 * - V1: the review lists what the destination lacks, and a question is answered with
 *   sources that are pages of this municipality's panel only.
 * - V2: «Proponer» asks for a proposal; its diff is reviewed field by field; accepting only
 *   the summary saves a DRAFT (nothing is published). A proposal made before someone saved
 *   the draft is refused with a message and nothing changes (RC of the step).
 * - An analyst asks and reads the review but cannot ask for proposals.
 * - No critical or serious axe findings and no horizontal overflow at 390 and 1280 px.
 */
import { randomUUID } from "node:crypto";

import axe from "axe-core";
import { chromium, type Browser, type Page } from "playwright-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { passSecondFactor } from "./support/second-factor";

const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = Number(process.env.RIKUY_PORT ?? 3000);
const ADMIN = `http://app.localhost:${PORT}`;
const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SUR = "5eed1000-0000-4000-8000-000000000002";
const OWNER_SUR = "5eed0000-0000-4000-8000-000000000002";
const TITLE = `Mirador del copilot ${randomUUID().slice(0, 6)}`;

const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
let browser: Browser;
let contentId = "";

async function asOwner<T>(work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return (await db.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: OWNER_SUR, role: "authenticated", aal: "aal2" })}, true)`;
    await tx`set local role authenticated`;
    return work(tx);
  })) as T;
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

async function signedIn(email: string): Promise<Page> {
  const page = await (
    await browser.newContext({ viewport: { width: 1280, height: 900 } })
  ).newPage();
  await page.goto(`${ADMIN}/login`);
  await page.getByLabel("Correo electrónico").fill(email);
  const since = Date.now();
  await page.getByRole("button", { name: "Recibir código" }).click();
  await page.getByLabel("Código de acceso").waitFor();
  await page.getByLabel("Código de acceso").fill(await emailCode(email, since));
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

async function revisions() {
  const [row] = await db`
    select d.summary as draft_summary, d.body as draft_body, p.summary as published_summary
    from public.content_items i
    left join public.content_revisions d on d.id = i.draft_revision_id
    left join public.content_revisions p on p.id = i.published_revision_id
    where i.id = ${contentId}`;
  return row as { draft_summary: string | null; draft_body: unknown; published_summary: string };
}

describe("the Copilot in the panel", () => {
  beforeAll(async () => {
    contentId = await asOwner(async (tx) => {
      const [created] = await tx`
        select content_id from public.create_content_item(${SUR}, 'destination', ${`copilot-${randomUUID().slice(0, 8)}`}, ${TITLE})`;
      const id = created?.content_id as string;
      const document = {
        title: TITLE,
        summary: "Un mirador.",
        body: [],
        location: { lat: -17.5, lng: -66.2 },
        cover: null,
        gallery: [],
      };
      await tx`select * from public.save_content_draft(${SUR}, ${id}, ${tx.json(document)}, 1)`;
      await tx`select * from public.publish_content(${SUR}, ${id}, 2)`;
      return id;
    });
    browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await db.end({ timeout: 5 });
  });

  it("V1 and V2: review, a question, a proposal accepted field by field into a draft, and a stale one refused", async () => {
    const page = await signedIn("owner@demo-sur.example.test");
    await page.goto(`${ADMIN}/o/demo-sur`);
    await page.getByRole("link", { name: /^Copilot/u }).click();
    await page.waitForURL(/\/o\/demo-sur\/copilot$/u);

    // V1: the review (fixed rules), with this destination and what it lacks.
    const row = page
      .locator("section[aria-labelledby=revision] tbody tr")
      .filter({ hasText: TITLE });
    await expect.poll(() => row.innerText()).toContain("Resumen muy corto");
    expect(await row.innerText()).toContain("Sin texto");

    // V1: a question; every source is a page of this municipality's panel.
    await page.getByRole("button", { name: "¿Qué contenidos están incompletos?" }).click();
    const answer = page.locator(".copilot-turn-answer").first();
    await answer.waitFor({ timeout: 20_000 });
    const links = await answer
      .locator("a")
      .evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute("href") ?? ""));
    expect(links.length).toBeGreaterThan(0);
    for (const href of links) expect(href.startsWith("/o/demo-sur/")).toBe(true);
    await accessible(page, "copilot");

    // V2: «Proponer» for this destination, summary and text.
    await row.getByRole("link", { name: `Proponer textos para ${TITLE}` }).click();
    await page.waitForURL(/\/copilot\/proponer\?/u);
    expect(
      await page
        .locator("input[name=fields]:checked")
        .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)),
    ).toEqual(["summary", "body"]);
    await accessible(page, "proponer");
    await page.getByRole("button", { name: "Pedir la propuesta" }).click();
    await page.waitForURL(/\/copilot\/propuestas\//u, { timeout: 30_000 });
    expect(await page.locator(".copilot-change legend").allInnerTexts()).toEqual([
      "Resumen",
      "Texto",
    ]);
    const summary = page.locator("fieldset.copilot-change").first();
    expect(await summary.locator("del").count()).toBeGreaterThan(0);
    expect(await summary.locator("ins").count()).toBeGreaterThan(0);
    await accessible(page, "propuesta");

    // Accept only the summary: a draft, nothing published.
    await page
      .locator("fieldset.copilot-change")
      .filter({ hasText: "Texto" })
      .getByRole("checkbox", { name: "Guardar este cambio" })
      .uncheck();
    await page.getByRole("button", { name: "Aceptar lo marcado (borrador)" }).click();
    await expect
      .poll(() => page.locator(".form-success").innerText())
      .toContain("se guardó como borrador (Resumen)");
    const afterAccept = await revisions();
    expect(afterAccept.draft_summary).toMatch(/^Resumen propuesto por el Copilot/u);
    expect(afterAccept.draft_body).toEqual([]);
    expect(afterAccept.published_summary).toBe("Un mirador.");

    // From the editor's button: a proposal on the open draft…
    await page.getByRole("link", { name: "Abrir en el editor" }).click();
    await page.getByRole("link", { name: "Proponer con el Copilot" }).click();
    await page.waitForURL(/\/copilot\/proponer\?/u);
    await page.getByRole("button", { name: "Pedir la propuesta" }).click();
    await page.waitForURL(/\/copilot\/propuestas\//u, { timeout: 30_000 });
    const proposalId = page.url().split("/").pop() ?? "";

    // …then someone saves the draft: accepting is refused and nothing changes.
    await asOwner(async (tx) => {
      const [draft] = await tx`
        select r.edit_count from public.content_items i join public.content_revisions r on r.id = i.draft_revision_id
        where i.id = ${contentId}`;
      const document = {
        title: TITLE,
        summary: "Resumen escrito a mano por una persona del equipo.",
        body: [],
        location: { lat: -17.5, lng: -66.2 },
        cover: null,
        gallery: [],
      };
      await tx`select * from public.save_content_draft(${SUR}, ${contentId}, ${tx.json(document)}, ${draft?.edit_count as number})`;
    });
    await page.getByRole("button", { name: "Aceptar lo marcado (borrador)" }).click();
    await expect
      .poll(() => page.locator(".field-error").innerText())
      .toContain("El contenido cambió");
    expect((await revisions()).draft_summary).toBe(
      "Resumen escrito a mano por una persona del equipo.",
    );
    const [proposal] =
      await db`select status from public.copilot_proposals where id = ${proposalId}`;
    expect(proposal?.status).toBe("pending");
    await page.reload();
    expect(await page.locator("main").innerText()).toContain("Desactualizada");
  }, 180_000);

  it("an analyst asks and reads the review, but cannot ask for proposals", async () => {
    const page = await signedIn("editor.ambos@example.test"); // analyst in Demo Sur
    await page.goto(`${ADMIN}/o/demo-sur/copilot`);
    await page.locator("section[aria-labelledby=revision]").waitFor();
    expect(await page.getByRole("link", { name: /^Proponer/u }).count()).toBe(0);
    expect(await page.locator("main").innerText()).toContain("no pedir propuestas");
    const response = await page.goto(`${ADMIN}/o/demo-sur/copilot/proponer?contenido=${contentId}`);
    expect(response?.status()).toBe(404);
    await page.goto(`${ADMIN}/o/demo-sur/copilot`);
    await accessible(page, "copilot (analyst)");
  }, 90_000);
});
