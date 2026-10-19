// Regression contracts in a real browser, against one production build (`next start`) and the
// seed of the local Supabase stack. The audit's contracts (14-regression-contracts-evals):
//
//   RC-09  usable at 360 / 390 / 768 / 1280 px: no unintended horizontal overflow (portal, admin)
//   RC-10  accessibility: automatic scan (axe) without critical or serious findings, skip link,
//          visible focus, reduced motion and a text alternative to the map canvas
//   RC-11  every internal link resolves (home, header, footer, cards); 404s are intentional
//   RC-12  server-rendered SEO unique per municipality and page; admin never indexed
//
// RC-06 (visitor location) has its own suite (location.e2e.mjs); RC-15 (access matrix) runs
// in the integration suite against the Data API.
//
// Usage: CHROME_PATH=/path/to/chrome node e2e/contracts.e2e.mjs [port]
//   The admin pages need a sign-in code: from Mailpit (MAILPIT_URL, as in CI) or, against a
//   local stand-in, a fixed code (E2E_EMAIL_CODE).
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { chromium } from "playwright-core";

const port = Number(process.argv[2] ?? 3000);
const executablePath = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
const require = createRequire(import.meta.url);
const AXE = await readFile(require.resolve("axe-core/axe.min.js"), "utf8");

const PORTALS = [
  {
    host: "demo-norte.localhost",
    name: "Municipio Demo Norte",
    other: "Municipio Demo Sur",
    destination: "mirador-del-valle",
    event: "feria-del-choclo",
  },
  {
    host: "demo-sur.localhost",
    name: "Municipio Demo Sur",
    other: "Municipio Demo Norte",
    destination: "laguna-espejo",
    event: "noche-de-estrellas",
  },
];
const ADMIN = `http://app.localhost:${port}`;
const OWNER = "owner@demo-norte.example.test";
const VIEWPORTS = [360, 390, 768, 1280];

// A blank map style: the checks need the page, not the map's tiles (and no internet).
const BLANK_STYLE = JSON.stringify({
  version: 8,
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": "#e8efe9" } }],
});

let failures = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failures += 1;
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : error}`);
  }
}

const browser = await chromium.launch({
  executablePath,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

async function newContext(width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.route("https://tiles.openfreemap.org/**", (route) =>
    route.request().url().includes("/styles/")
      ? route.fulfill({ contentType: "application/json", body: BLANK_STYLE })
      : route.abort(),
  );
  return context;
}

/** The pages of one portal that the contracts walk through. */
function portalPages(portal) {
  return [
    "/",
    "/destinos",
    `/destinos/${portal.destination}`,
    "/agenda",
    `/agenda/${portal.event}`,
    "/mapa",
    "/privacidad",
    "/terminos",
    "/destinos/no-existe",
  ].map((path) => ({
    label: `${portal.host}${path}`,
    url: `http://${portal.host}:${port}${path}`,
  }));
}

// ── Sign-in for the admin pages ─────────────────────────────────────────────────
async function emailCode(email, since) {
  if (process.env.E2E_EMAIL_CODE) return process.env.E2E_EMAIL_CODE;
  const mailpit = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const search = await (
      await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)
    ).json();
    const id = search.messages?.find((m) => Date.parse(m.Created) >= since - 1000)?.ID;
    if (id) {
      const message = await (await fetch(`${mailpit}/api/v1/message/${id}`)).json();
      const code = /\b(\d{6})\b/u.exec(`${message.Text ?? ""} ${message.HTML ?? ""}`)?.[1];
      if (code) return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no sign-in email for ${email}`);
}

async function signIn(context, email) {
  const page = await context.newPage();
  await page.goto(`${ADMIN}/login`);
  await page.getByLabel("Correo electrónico").fill(email);
  const since = Date.now();
  await page.getByRole("button", { name: "Recibir código" }).click();
  await page.getByLabel("Código de acceso").waitFor();
  await page.getByLabel("Código de acceso").fill(await emailCode(email, since));
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });
  return page;
}

/** The admin pages of the owner's municipality, with real ids taken from its lists. */
async function adminPages(page) {
  const base = `${ADMIN}/o/demo-norte`;
  const firstEditor = async (list) => {
    await page.goto(`${base}/${list}`);
    const href = await page
      .locator(`a[href^="/o/demo-norte/${list}/"]`)
      .first()
      .getAttribute("href");
    assert.ok(href, `no item in /${list}`);
    return `${ADMIN}${href}`;
  };
  const destination = await firstEditor("destinos");
  const event = await firstEditor("agenda");
  return [
    `${ADMIN}/`,
    base,
    `${base}/destinos`,
    destination,
    `${base}/agenda`,
    event,
    `${base}/configuracion`,
    `${base}/miembros`,
  ].map((url) => ({ label: url.replace(`http://app.localhost:${port}`, "admin"), url }));
}

// ── RC-09 · no horizontal overflow at four widths ──────────────────────────────
async function overflowing(page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth <= width + 1) return null;
    // Name the widest offenders, skipping those inside an explicit scroll container.
    const inScroller = (element) => {
      for (let node = element.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (/(auto|scroll)/u.test(style.overflowX)) return true;
      }
      return false;
    };
    const offenders = [...document.body.querySelectorAll("*")]
      .filter(
        (element) => element.getBoundingClientRect().right > width + 1 && !inScroller(element),
      )
      .slice(0, 4)
      .map(
        (element) => `${element.tagName.toLowerCase()}.${String(element.className).split(" ")[0]}`,
      );
    return `${document.documentElement.scrollWidth}px > ${width}px: ${offenders.join(", ")}`;
  });
}

async function checkWidths(pages, context) {
  const page = await context.newPage();
  for (const width of VIEWPORTS) {
    await page.setViewportSize({ width, height: 900 });
    for (const { label, url } of pages) {
      await check(`RC-09 · ${label} at ${width}px has no horizontal overflow`, async () => {
        await page.goto(url, { waitUntil: "networkidle" });
        assert.equal(await overflowing(page), null);
      });
    }
  }
  await page.close();
}

// ── RC-10 · accessibility ──────────────────────────────────────────────────────
async function axeFindings(page) {
  await page.addScriptTag({ content: AXE });
  return page.evaluate(async () => {
    const result = await window.axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"],
      },
      resultTypes: ["violations"],
    });
    return result.violations
      .filter((violation) => violation.impact === "critical" || violation.impact === "serious")
      .map(
        (violation) =>
          `${violation.id} (${violation.impact}): ${violation.nodes
            .slice(0, 3)
            .map((node) => node.target.join(" "))
            .join(" | ")}`,
      );
  });
}

async function checkAccessibility(pages, context) {
  const page = await context.newPage();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const { label, url } of pages) {
      await check(
        `RC-10 · ${label} at ${width}px: no critical or serious axe findings`,
        async () => {
          await page.goto(url, { waitUntil: "networkidle" });
          assert.deepEqual(await axeFindings(page), []);
        },
      );
    }
  }
  await page.close();
}

async function checkKeyboard(url, label, signedIn) {
  const context = signedIn ?? (await newContext());
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  await check(
    `RC-10 · ${label}: the first Tab reaches «Saltar al contenido», which works`,
    async () => {
      await page.keyboard.press("Tab");
      const focused = await page.evaluate(() => ({
        text: document.activeElement?.textContent?.trim(),
        outline: getComputedStyle(document.activeElement).outlineStyle,
        visible: document.activeElement.getBoundingClientRect().top >= 0,
      }));
      assert.equal(focused.text, "Saltar al contenido");
      assert.notEqual(focused.outline, "none", "focus is visible");
      assert.ok(focused.visible, "the skip link shows when focused");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Tab");
      const inMain = await page.evaluate(() =>
        Boolean(document.activeElement?.closest("#contenido")),
      );
      assert.ok(inMain, "the next Tab lands inside the main content");
    },
  );
  if (signedIn) await page.close();
  else await context.close();
}

async function checkReducedMotion(portal) {
  const context = await newContext();
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`http://${portal.host}:${port}/`, { waitUntil: "networkidle" });
  await check(`RC-10 · ${portal.host}: nothing animates with prefers-reduced-motion`, async () => {
    const running = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((animation) => animation.playState === "running")
        .map((animation) => animation.animationName ?? animation.constructor.name),
    );
    assert.deepEqual(running, []);
  });
  await context.close();
}

async function checkMapAlternative(portal) {
  const context = await newContext();
  const page = await context.newPage();
  await page.goto(`http://${portal.host}:${port}/mapa`, { waitUntil: "networkidle" });
  await check(`RC-10 · ${portal.host}/mapa: the list says the same as the canvas`, async () => {
    const pins = await page.locator(".map-marker").count();
    const rows = await page.locator(".portal-map-list li a").count();
    assert.ok(rows > 0, "the list has places");
    assert.equal(rows, pins, "one list row per pin");
    for (const name of await page
      .locator(".map-marker")
      .evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label")))) {
      assert.match(name ?? "", /^(Destino|Evento): .+/u, "every pin has an accessible name");
    }
  });
  await context.close();
}

// ── RC-11 · every internal link resolves ───────────────────────────────────────
async function crawl(context, start, origin, limit = 80) {
  const seen = new Set([start]);
  const queue = [start];
  const broken = [];
  const page = await context.newPage();
  while (queue.length > 0 && seen.size <= limit) {
    const url = queue.shift();
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    const status = response?.status() ?? 0;
    if (status >= 400) {
      broken.push(`${url} → ${status}`);
      continue;
    }
    if (!(response?.headers()["content-type"] ?? "").includes("text/html")) continue;
    const links = await page
      .locator("a[href]")
      .evaluateAll((anchors) =>
        anchors
          .filter((anchor) => anchor.target !== "_blank" && !anchor.hasAttribute("download"))
          .map((anchor) => anchor.href),
      );
    for (const link of links) {
      const target = new URL(link);
      target.hash = "";
      if (target.origin !== origin || seen.has(target.href)) continue;
      seen.add(target.href);
      queue.push(target.href);
    }
  }
  await page.close();
  return { visited: seen.size, broken };
}

// ── RC-12 · SEO per municipality ───────────────────────────────────────────────
async function seoOf(page, url) {
  const response = await page.goto(url, { waitUntil: "domcontentloaded" });
  const html = await response.text();
  return page.evaluate(
    ({ html }) => {
      const meta = (selector) => document.querySelector(selector)?.getAttribute("content") ?? null;
      return {
        // Server-rendered: the title is in the HTML itself, not added by scripts.
        ssrTitle: /<title>([^<]*)<\/title>/u.exec(html)?.[1] ?? null,
        title: document.title,
        description: meta('meta[name="description"]'),
        canonical: document.querySelector('link[rel="canonical"]')?.href ?? null,
        ogTitle: meta('meta[property="og:title"]'),
        robots: meta('meta[name="robots"]'),
        h1: document.querySelector("h1")?.textContent?.trim() ?? null,
      };
    },
    { html },
  );
}

async function checkSeo(portal) {
  const context = await newContext();
  const page = await context.newPage();
  const origin = `http://${portal.host}:${port}`;
  const indexable = [
    "/",
    "/destinos",
    `/destinos/${portal.destination}`,
    "/agenda",
    `/agenda/${portal.event}`,
    "/mapa",
  ];
  const titles = new Map();
  for (const path of indexable) {
    await check(
      `RC-12 · ${portal.host}${path}: own title, description, canonical and Open Graph`,
      async () => {
        const seo = await seoOf(page, `${origin}${path}`);
        assert.ok(seo.ssrTitle, "the title is server-rendered");
        assert.ok(seo.title.includes(portal.name), `title names the municipality: ${seo.title}`);
        assert.ok(!seo.title.includes(portal.other), "no other municipality in the title");
        assert.ok(seo.description && seo.description.length > 20, "has a description");
        assert.ok(
          !seo.description.includes(portal.other),
          "no other municipality in the description",
        );
        assert.equal(new URL(seo.canonical ?? "").origin, origin, "canonical on its own host");
        assert.equal(new URL(seo.canonical ?? "").pathname, path, "canonical is the page itself");
        assert.ok(seo.ogTitle, "has og:title");
        assert.ok(seo.h1, "has one main heading");
        assert.ok(!titles.has(seo.title), `title shared with ${titles.get(seo.title)}`);
        titles.set(seo.title, path);
      },
    );
  }
  await check(`RC-12 · ${portal.host}: a missing page answers 404 and is not indexed`, async () => {
    const response = await page.goto(`${origin}/destinos/no-existe`);
    assert.equal(response?.status(), 404);
    const robots = await page.locator('meta[name="robots"]').getAttribute("content");
    assert.match(robots ?? "", /noindex/u);
  });
  await context.close();
}

async function checkAdminNotIndexed(context, pages) {
  const page = await context.newPage();
  for (const { label, url } of [{ label: "admin/login", url: `${ADMIN}/login` }, ...pages]) {
    await check(`RC-12 · ${label} is never indexed`, async () => {
      const response = await page.goto(url, { waitUntil: "domcontentloaded" });
      const header = response?.headers()["x-robots-tag"] ?? "";
      const meta = (await page.locator('meta[name="robots"]').getAttribute("content")) ?? "";
      assert.match(header, /noindex/u, "X-Robots-Tag");
      assert.match(meta, /noindex/u, "robots meta");
    });
  }
  await page.close();
}

// ── Run ────────────────────────────────────────────────────────────────────────
const portalList = PORTALS.flatMap(portalPages);

{
  const context = await newContext();
  await checkWidths(portalList, context);
  await checkAccessibility(portalList, context);
  await context.close();
}
for (const portal of PORTALS) {
  await checkKeyboard(`http://${portal.host}:${port}/`, portal.host);
  await checkReducedMotion(portal);
  await checkMapAlternative(portal);
  await checkSeo(portal);
  await check(`RC-11 · ${portal.host}: every internal link resolves`, async () => {
    const context = await newContext();
    const origin = `http://${portal.host}:${port}`;
    const { visited, broken } = await crawl(context, `${origin}/`, origin);
    await context.close();
    assert.ok(visited >= 8, `crawled only ${visited} pages`);
    assert.deepEqual(broken, []);
  });
}

{
  const context = await newContext();
  const page = await signIn(context, OWNER);
  const pages = await adminPages(page);
  await page.close();
  await checkWidths(pages, context);
  await checkAccessibility(pages, context);
  await checkKeyboard(pages[1].url, "admin municipality page", context);
  await checkAdminNotIndexed(context, pages);
  await check("RC-11 · admin: every internal link of the owner resolves", async () => {
    const { visited, broken } = await crawl(context, `${ADMIN}/`, ADMIN, 60);
    assert.ok(visited >= 8, `crawled only ${visited} pages`);
    assert.deepEqual(broken, []);
  });
  await context.close();
}

await browser.close();
console.log(`contracts e2e: ${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
