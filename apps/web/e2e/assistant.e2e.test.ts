/**
 * The visitor's assistant (P5 · Paso 3, ADR-038) in a real browser, against the production
 * build (`next start`), the local Supabase stack and the simulated model (AI_PROVIDER=
 * simulated): no network, deterministic answers that cite their first passage. CI job
 * "Contracts".
 *
 * What it proves: the button is in every page and the panel is downloaded only when it is
 * opened; an answer cites a published page of THIS municipality and links to it; an
 * invented citation and a web address never reach the visitor; a question in English is
 * answered in English; the conversation stays in this browser (24 h) until «Nueva
 * conversación»; a plan (P5 · Paso 4) sends distances, never the visitor's position, and
 * opens its route on the map; a dictated question (P5 · Paso 6) waits in the field to be
 * reviewed, its answer is read aloud, and without permission, quota or provider the visitor
 * types; the endpoint refuses another origin; with the AI quota used up the visitor
 * gets a notice and the portal; and the panel works by keyboard, on a phone, without axe
 * findings.
 *
 *   SUPABASE_DB_URL=… pnpm --filter @rikuy/web test:e2e-assistant
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { drainJobs } from "@rikuy/core";
import { createPostgresJobLedger } from "@rikuy/db/worker";
import { createIndexKnowledgeProcessor } from "@rikuy/worker";
import axe from "axe-core";
import { chromium, type Browser, type Page } from "playwright-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = Number(process.env.RIKUY_PORT ?? 3000);
const PORTAL = `http://demo-sur.localhost:${PORT}`;
const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SUR = "5eed1000-0000-4000-8000-000000000002";
const STORAGE_KEY = "rikuy.assistant.v1";

const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
let browser: Browser;

async function serious(page: Page): Promise<string[]> {
  await page.addScriptTag({ content: axe.source });
  return page.evaluate(async () => {
    const run = await (
      window as unknown as {
        axe: {
          run: (
            context: Document,
            options: object,
          ) => Promise<{ violations: { id: string; impact: string }[] }>;
        };
      }
    ).axe.run(document, { resultTypes: ["violations"] });
    return run.violations
      .filter((violation) => violation.impact === "critical" || violation.impact === "serious")
      .map((violation) => violation.id);
  });
}

/** A mono 16 kHz WAV with a soft tone: what the fake microphone plays in a loop. */
function toneWav(seconds: number): Buffer {
  const rate = 16_000;
  const samples = rate * seconds;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) {
    wav.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 440 * index) / rate) * 8000),
      44 + index * 2,
    );
  }
  return wav;
}

/** The browser's voice, recorded in window.__spoken instead of spoken. */
const SPEECH_STUB = `
  window.__spoken = [];
  if ("speechSynthesis" in window) {
    const synth = window.speechSynthesis;
    synth.getVoices = () => [];
    synth.cancel = () => {};
    synth.speak = (utterance) => {
      window.__spoken.push(utterance.text);
      setTimeout(() => utterance.dispatchEvent(new Event("end")), 50);
    };
  }
`;

async function ask(page: Page, question: string) {
  const before = await page.locator(".assistant-from-assistant").count();
  await page.getByLabel(/Tu pregunta para/u).fill(question);
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll(".assistant-from-assistant").length > count &&
      !document.querySelector(".assistant-typing"),
    before,
  );
  return page.locator(".assistant-from-assistant").last();
}

describe("the visitor's assistant (simulated model)", () => {
  beforeAll(async () => {
    // A clean hour for this visitor (10 questions per hour, ADR-036): earlier runs on the
    // same stack would otherwise count.
    await db`delete from public.ai_executions where tenant_id = ${SUR}`;
    await db`delete from public.ai_requests where tenant_id = ${SUR}`;
    // What the seed published, indexed by the real indexer (ADR-037) under this run's keys.
    const run = Date.now();
    await db`
      select private.enqueue_job(i.tenant_id, 'knowledge.index',
        'content_revision:' || i.published_revision_id || ':e2e' || ${run}::text,
        jsonb_build_object('source', 'content', 'revisionId', i.published_revision_id),
        'content_revision', i.published_revision_id)
      from public.content_items i where i.tenant_id = ${SUR} and i.published_revision_id is not null
    `;
    const ledger = createPostgresJobLedger({
      url: DB_URL,
      role: "rikuy_worker",
      maxConnections: 2,
    });
    try {
      await drainJobs({
        ledger,
        processors: [
          createIndexKnowledgeProcessor({
            knowledge: ledger.knowledge,
            // The seed has no documents: the indexer never reads a file here.
            media: {
              readOriginal: () => Promise.reject(new Error("no documents in the seed")),
            },
          }),
        ],
        runnerId: "e2e-assistant",
        budgetMs: 30_000,
        concurrency: 2,
      });
    } finally {
      await ledger.close();
    }
    browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
    });
  });

  afterAll(async () => {
    // Demo Sur gets its default AI quota back, today's bucket included.
    await db`delete from public.tenant_quotas where tenant_id = ${SUR} and resource = 'ai_tokens'`;
    await db`
      update public.usage_buckets set limit_amount = private.quota_limit(${SUR}, 'ai_tokens')
      where tenant_id = ${SUR} and resource = 'ai_tokens' and period_end > now()
    `;
    await browser?.close();
    await db.end({ timeout: 5 });
  });

  it("opens from every page, loads only on demand, and answers citing this municipality", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const scripts: string[] = [];
    const hosts = new Set<string>();
    page.on("request", (request) => {
      hosts.add(new URL(request.url()).hostname);
      if (request.resourceType() === "script") scripts.push(request.url());
    });
    for (const path of ["/", "/destinos", "/agenda", "/mapa", "/destinos/laguna-espejo"]) {
      await page.goto(`${PORTAL}${path}`);
      await expect(page.getByRole("button", { name: /hacer una pregunta/u }).count()).resolves.toBe(
        1,
      );
    }
    await page.waitForLoadState("networkidle");
    const loaded = scripts.length;

    const launcher = page.getByRole("button", { name: /hacer una pregunta/u });
    expect((await launcher.innerText()).split("\n")[0]).toBe("Asistente");
    // From here on, only the assistant's requests count (the map asks its own tiles).
    hosts.clear();
    await launcher.click();
    const dialog = page.getByRole("dialog", { name: "Asistente" });
    await dialog.waitFor();
    // The panel's code came now, not with the page.
    expect(scripts.length).toBeGreaterThan(loaded);
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("TEXTAREA");
    expect(await dialog.locator(".assistant-from-assistant").first().innerText()).toContain(
      "Municipio Demo Sur",
    );

    // Asked from the lake's page: it cites the lake, with a link to its page.
    const answer = await ask(page, "¿Qué se ve de noche?");
    const source = answer.locator(".assistant-sources a").first();
    expect(["/destinos/laguna-espejo", "/agenda/noche-de-estrellas"]).toContain(
      await source.getAttribute("href"),
    );
    // Never another municipality's page (Demo Norte has a «Mirador del Valle»).
    const other = await ask(page, "¿Qué hay en el Mirador del Valle?");
    for (const href of await other
      .locator("a")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href")))) {
      expect(href).not.toContain("mirador-del-valle");
    }

    // Validation: an invented citation is dropped; a web address never shows.
    const invented = await ask(page, "laguna [simular:cita-falsa]");
    expect(await invented.locator(".assistant-sources").count()).toBe(0);
    expect(await invented.locator(".assistant-abstained").innerText()).toBe(
      "Sin fuentes publicadas.",
    );
    const linked = await ask(page, "laguna [simular:enlace]");
    expect(await linked.innerText()).not.toContain("ejemplo.invalid");

    // In English, in English.
    const english = await ask(page, "What is there to see at the lake?");
    expect(await english.getAttribute("lang")).toBe("en");

    expect(await serious(page)).toEqual([]);
    // Nothing but this portal and its storage was asked: no third party for the assistant
    // (the place's small map, which any touch of the page wakes up, asks for its tiles).
    expect(
      [...hosts].filter(
        (host) =>
          !host.endsWith("localhost") && host !== "127.0.0.1" && !host.endsWith("openfreemap.org"),
      ),
    ).toEqual([]);

    // Escape closes and gives the focus back to the button.
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("dialog.assistant[open]"));
    expect(await page.evaluate(() => document.activeElement?.className)).toContain(
      "portal-assistant-launcher",
    );

    // The conversation stays in this browser…
    await page.reload();
    await page.getByRole("button", { name: /hacer una pregunta/u }).click();
    await page.locator(".assistant-from-visitor").first().waitFor();
    expect(await page.locator(".assistant-from-visitor").count()).toBe(5);
    const stored = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
    expect(stored).toContain("¿Qué se ve de noche?");
    // …until «Nueva conversación».
    await page.getByRole("button", { name: "Nueva conversación" }).click();
    expect(await page.locator(".assistant-from-visitor").count()).toBe(0);
    expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
    await context.close();
  });

  it("is a modal on a phone, without overflow or axe findings", async () => {
    const context = await browser.newContext({ viewport: { width: 360, height: 780 } });
    const page = await context.newPage();
    await page.goto(`${PORTAL}/`);
    await page.getByRole("button", { name: /hacer una pregunta/u }).click();
    await page.getByRole("dialog").waitFor();
    await ask(page, "¿Qué es la laguna espejo?");
    const box = await page.locator("dialog.assistant").boundingBox();
    expect(box?.width).toBe(360);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false);
    expect(await serious(page)).toEqual([]);
    await context.close();
  });

  it("refuses another origin and a malformed question", async () => {
    // *.localhost is asked at 127.0.0.1 with its Host (not every system resolves it).
    const post = (origin: string, body: string) =>
      new Promise<{ status: number; cache: string | undefined }>((resolve, reject) => {
        const request = http.request(
          {
            host: "127.0.0.1",
            port: PORT,
            path: "/asistente",
            method: "POST",
            headers: {
              host: `demo-sur.localhost:${PORT}`,
              origin,
              "content-type": "application/json",
            },
          },
          (response) => {
            response.resume();
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                cache: response.headers["cache-control"],
              }),
            );
          },
        );
        request.on("error", reject);
        request.end(body);
      });
    expect((await post("http://evil.example", '{"question":"hola"}')).status).toBe(403);
    expect((await post(PORTAL, '{"question":""}')).status).toBe(400);
    expect((await post(PORTAL, "no es json")).status).toBe(400);
    const answered = await post(PORTAL, '{"question":"¿Qué es la laguna espejo?"}');
    expect(answered).toEqual({ status: 200, cache: "no-store" });
  });

  it("plans (ADR-039): the location stays on the phone, only distances go, and the route opens on the map", async () => {
    // Next to the lake (Demo Sur), on a phone.
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      geolocation: { latitude: -21.5306, longitude: -64.7301 },
    });
    const page = await context.newPage();
    const sent: string[] = [];
    page.on("request", (request) => {
      sent.push(`${request.url()} ${request.postData() ?? ""}`);
    });
    await page.goto(`${PORTAL}/`);
    await page.getByRole("button", { name: /hacer una pregunta/u }).click();
    await page.getByRole("dialog").waitFor();

    // Without the location: no model call, a button to share it.
    const before = await page.locator(".assistant-from-assistant").count();
    await page.getByRole("button", { name: "¿Qué hay cerca?" }).click();
    await page.waitForFunction(
      (count) =>
        document.querySelectorAll(".assistant-from-assistant").length > count &&
        !document.querySelector(".assistant-typing"),
      before,
    );
    const share = page.locator(".assistant-plan .portal-location-button");
    expect(await share.count()).toBe(1);

    // Shared: the same plan again, with distances measured here.
    await context.grantPermissions(["geolocation"], { origin: PORTAL });
    await share.click();
    await page.locator(".assistant-plan-stop").first().waitFor({ timeout: 15_000 });
    const stop = page.locator(".assistant-plan-stop").first();
    expect(await stop.innerText()).toContain("Laguna Espejo");
    expect(await stop.locator("a").getAttribute("href")).toBe("/destinos/laguna-espejo");
    expect(await stop.innerText()).toContain("Sin horario publicado");

    // Only distances to this portal's places left the phone, never its coordinates.
    const asked = sent.filter((line) => line.includes("/asistente "));
    expect(asked.some((line) => line.includes('"destination:laguna-espejo":'))).toBe(true);
    expect(sent.some((line) => /-21\.53|-64\.73/u.test(line))).toBe(false);
    expect(sent.some((line) => /mirador-del-valle|plaza-principal/u.test(line))).toBe(false);

    expect(await serious(page)).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false);

    // «Verlos en el mapa»: the stops numbered, in order, as a list too.
    const map = await page.locator(".assistant-plan-map").last().getAttribute("href");
    // The star night is in 20 days: not «cerca» now.
    expect(map).toBe("/mapa?ruta=destination:laguna-espejo");
    await page.goto(`${PORTAL}${map}`);
    const stops = page.locator(".portal-route-stops li");
    await stops.first().waitFor();
    expect(await stops.first().innerText()).toContain("Laguna Espejo");
    // An unknown or another municipality's place in the address is left out.
    await page.goto(`${PORTAL}/mapa?ruta=destination:mirador-del-valle,destination:laguna-espejo`);
    expect(await page.locator(".portal-route-stops li").count()).toBe(1);
    expect(await serious(page)).toEqual([]);
    await context.close();
  });

  it("voice (ADR-041): a dictated question is reviewed before sending, its answer is read aloud, and text stays when the microphone or the provider fails", async () => {
    // A clean hour for this visitor: the earlier cases asked questions from the same address.
    await db`delete from public.ai_executions where tenant_id = ${SUR}`;
    await db`delete from public.ai_requests where tenant_id = ${SUR}`;
    // A microphone that "says" a 3 s tone (the simulated transcriber hears its question in it).
    const folder = mkdtempSync(join(tmpdir(), "rikuy-voice-"));
    const tone = join(folder, "tone.wav");
    writeFileSync(tone, toneWav(3));
    const voiceBrowser = await chromium.launch({
      executablePath: CHROME,
      args: [
        "--host-resolver-rules=MAP *.localhost 127.0.0.1",
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-audio-capture=${tone}`,
      ],
    });
    try {
      const context = await voiceBrowser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.grantPermissions(["microphone"], { origin: PORTAL });
      // The browser's voice, recorded instead of spoken (headless has no speakers).
      await context.addInitScript(SPEECH_STUB);
      const page = await context.newPage();
      // (Playwright does not see a Blob body: the server's records show what arrived.)
      const sent: { url: string; type: string | null }[] = [];
      page.on("request", (request) => {
        if (request.method() === "POST") {
          sent.push({
            url: new URL(request.url()).pathname,
            type: request.headers()["content-type"] ?? null,
          });
        }
      });
      await page.goto(`${PORTAL}/`);
      await page.getByRole("button", { name: /hacer una pregunta/u }).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      const field = page.getByLabel(/Tu pregunta para/u);
      const status = page.locator(".assistant-voice");

      // Dictate: listening, then the text appears in the field — and nothing is asked yet.
      await page.getByRole("button", { name: "Dictar la pregunta" }).click();
      await status.getByText(/Escuchando/u).waitFor();
      await page.waitForTimeout(1500);
      await page.getByRole("button", { name: "Terminar de dictar" }).click();
      await page.waitForFunction(
        () => (document.querySelector(".assistant-form textarea") as HTMLTextAreaElement)?.value,
      );
      expect(await field.inputValue()).toBe("¿Qué lugares puedo visitar?");
      expect(await status.innerText()).toBe("Revisa el texto y pulsa «Enviar».");
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("TEXTAREA");
      expect(sent.map((request) => request.url)).toEqual(["/asistente/dictado"]);
      expect(sent[0]?.type).toMatch(/^audio\/(webm|ogg|mp4)/u);
      expect(await serious(page)).toEqual([]);

      // Sent by the visitor; the answer to a dictated question is read aloud by itself.
      const before = await page.locator(".assistant-from-assistant").count();
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        (count) =>
          document.querySelectorAll(".assistant-from-assistant").length > count &&
          !document.querySelector(".assistant-typing"),
        before,
      );
      const answer = page.locator(".assistant-from-assistant").last();
      await page.waitForFunction(
        () => (window as unknown as { __spoken: string[] }).__spoken.length > 0,
      );
      const spoken = await page.evaluate(
        () => (window as unknown as { __spoken: string[] }).__spoken,
      );
      // The answer's own words (whatever the simulated model said), never its sources.
      const said = await answer.locator("p:not(.visually-hidden)").first().innerText();
      expect(spoken.join(" ")).toContain(said.replace(/\s+/gu, " ").trim().slice(0, 40));
      expect(spoken.join(" ")).not.toMatch(/https?:|Fuentes/u);
      // «Escuchar» again, by hand, on any answer.
      await answer.getByRole("button", { name: "Escuchar" }).waitFor();
      await answer.getByRole("button", { name: "Escuchar" }).click();
      await page.waitForFunction(
        () => (window as unknown as { __spoken: string[] }).__spoken.length > 1,
      );
      // A typed question is not read aloud.
      await page.evaluate(() => ((window as unknown as { __spoken: string[] }).__spoken = []));
      await ask(page, "¿Qué es la laguna espejo?");
      await page.waitForTimeout(2000);
      expect(
        await page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken),
      ).toEqual([]);

      // Counted in seconds: one dictation, billed at least 10 s, no audio nor text kept.
      const [dictation] = await db`
        select status, outcome, audio_seconds, reserved_tokens from public.ai_requests
        where tenant_id = ${SUR} and profile = 'dictation'
      `;
      expect(dictation).toMatchObject({
        status: "completed",
        outcome: "transcribed",
        reserved_tokens: "0",
      });
      expect(Number(dictation?.audio_seconds)).toBeGreaterThanOrEqual(10);

      // Escape while listening throws the recording away and keeps the panel open.
      await field.fill("");
      await page.getByRole("button", { name: "Dictar la pregunta" }).click();
      await status.getByText(/Escuchando/u).waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Dictar la pregunta" }).waitFor();
      expect(await dialog.isVisible()).toBe(true);
      await page.waitForTimeout(500);
      expect(sent.filter((request) => request.url === "/asistente/dictado")).toHaveLength(1);

      // The provider down, or nothing said: a message, and the field stays for typing.
      const post = (marker: string) =>
        page.evaluate(async (text) => {
          const bytes = new Uint8Array(4096);
          bytes.set(new TextEncoder().encode("RIFF"), 0);
          bytes.set(new TextEncoder().encode("WAVE"), 8);
          bytes.set(new TextEncoder().encode(text), 64);
          const response = await fetch("/asistente/dictado", {
            method: "POST",
            headers: { "content-type": "audio/wav" },
            body: bytes,
          });
          return {
            status: response.status,
            body: (await response.json()) as { status: string; message?: string },
          };
        }, marker);
      expect(await post("[simular:caida]")).toEqual({
        status: 200,
        body: {
          status: "notice",
          message: "No pude pasar tu voz a texto en este momento. Puedes escribir tu pregunta.",
        },
      });
      expect((await post("[simular:silencio]")).body.status).toBe("empty");
      // Not audio: refused before any quota.
      const html = await page.evaluate(async () => {
        const response = await fetch("/asistente/dictado", {
          method: "POST",
          headers: { "content-type": "audio/webm" },
          body: "<!doctype html><html>".repeat(100),
        });
        return response.status;
      });
      expect(html).toBe(400);

      // The municipality's dictation used up: a message by the field, and typing still answers.
      await db`
        insert into public.tenant_quotas (tenant_id, resource, limit_amount)
        values (${SUR}, 'ai_audio_seconds', 0)
        on conflict (tenant_id, resource) do update set limit_amount = 0
      `;
      await db`
        update public.usage_buckets set limit_amount = 0
        where tenant_id = ${SUR} and resource = 'ai_audio_seconds' and period_end > now()
      `;
      await page.getByRole("button", { name: "Dictar la pregunta" }).click();
      await status.getByText(/Escuchando/u).waitFor();
      await page.waitForTimeout(1000);
      await page.getByRole("button", { name: "Terminar de dictar" }).click();
      await status
        .getByText("El dictado por voz ya no está disponible por hoy. Puedes escribir tu pregunta.")
        .waitFor();
      expect(await field.inputValue()).toBe("");
      const typed = await ask(page, "¿Qué es la laguna espejo?");
      expect(await typed.getAttribute("class")).not.toContain("assistant-problem");
      await context.close();

      // Without permission for the microphone: a message, and the field.
      const denied = await voiceBrowser.newContext({ viewport: { width: 390, height: 844 } });
      await denied.addInitScript(() => {
        navigator.mediaDevices.getUserMedia = () =>
          Promise.reject(new DOMException("denied", "NotAllowedError"));
      });
      const deniedPage = await denied.newPage();
      await deniedPage.goto(`${PORTAL}/`);
      await deniedPage.getByRole("button", { name: /hacer una pregunta/u }).click();
      await deniedPage.getByRole("button", { name: "Dictar la pregunta" }).click();
      await deniedPage
        .locator(".assistant-voice")
        .getByText("Sin permiso para usar el micrófono. Puedes escribir tu pregunta.")
        .waitFor();
      expect(await deniedPage.getByLabel(/Tu pregunta para/u).isEditable()).toBe(true);
      expect(await serious(deniedPage)).toEqual([]);
      expect(
        await deniedPage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      ).toBe(false);
      await denied.close();

      // A browser that cannot record: no microphone button, the rest as always.
      const unable = await voiceBrowser.newContext({ viewport: { width: 1280, height: 900 } });
      await unable.addInitScript(() => {
        delete (window as unknown as { MediaRecorder?: unknown }).MediaRecorder;
      });
      const unablePage = await unable.newPage();
      await unablePage.goto(`${PORTAL}/`);
      await unablePage.getByRole("button", { name: /hacer una pregunta/u }).click();
      await unablePage.getByRole("dialog").waitFor();
      expect(await unablePage.locator(".assistant-mic").count()).toBe(0);
      await unable.close();
    } finally {
      await db`delete from public.tenant_quotas where tenant_id = ${SUR} and resource = 'ai_audio_seconds'`;
      await db`
        update public.usage_buckets set limit_amount = private.quota_limit(${SUR}, 'ai_audio_seconds')
        where tenant_id = ${SUR} and resource = 'ai_audio_seconds' and period_end > now()
      `;
      await voiceBrowser.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("with the AI quota used up, the visitor gets a notice and the portal keeps working", async () => {
    await db`
      insert into public.tenant_quotas (tenant_id, resource, limit_amount)
      values (${SUR}, 'ai_tokens', 0)
      on conflict (tenant_id, resource) do update set limit_amount = 0
    `;
    await db`
      update public.usage_buckets set limit_amount = 0
      where tenant_id = ${SUR} and resource = 'ai_tokens' and period_end > now()
    `;
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${PORTAL}/`);
    await page.getByRole("button", { name: /hacer una pregunta/u }).click();
    const notice = await ask(page, "¿Qué es la laguna espejo?");
    expect(await notice.innerText()).toContain("Por hoy ya respondí todas las preguntas");
    expect(
      await notice
        .locator("nav a")
        .evaluateAll((links) => links.map((l) => l.getAttribute("href"))),
    ).toEqual(expect.arrayContaining(["/destinos", "/agenda", "/mapa"]));
    for (const path of ["/", "/destinos", "/destinos/laguna-espejo"]) {
      expect((await page.goto(`${PORTAL}${path}`))?.status()).toBe(200);
    }
    await context.close();
  });
});
