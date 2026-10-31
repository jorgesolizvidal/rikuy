// Lighthouse against one production build (`next start`) and the seed, or against the
// deployed sites (LIGHTHOUSE_ORIGINS): every public page kind of each portal (from its sitemap),
// measured `runs` times (mobile, simulated 4G, CPU x4); the median run must meet
// lighthouse-budget.json. Fails the CI step when a page breaks it.
//
// Usage: CHROME_PATH=/path/to/chrome node e2e/lighthouse.mjs [port]
//   Writes lighthouse-reports/<page>.json and a summary table (also to $GITHUB_STEP_SUMMARY).
//
// LIGHTHOUSE_SET=tours measures the tour pages instead (P4 · Paso 7): the first tour page in
// each portal's sitemap and the general tour (/recorrido). Tours are data, not seed, so they
// are found where they are published; a portal without tours is skipped, and with
// LIGHTHOUSE_REQUIRE_TOURS=1 finding none fails the step.
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import lighthouse from "lighthouse";

const port = Number(process.argv[2] ?? 3000);
const executablePath = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const budget = JSON.parse(await readFile(new URL("../lighthouse-budget.json", import.meta.url)));
const OUT = new URL("../lighthouse-reports/", import.meta.url);
const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];

// In GitHub Actions the reason also goes out as an annotation, readable on the run page
// and through the API even when the job's log cannot be downloaded.
const annotate = (message, level = "error") => {
  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(`::${level} title=Lighthouse::${String(message).replace(/\r?\n/gu, "%0A")}`);
  }
};
for (const event of ["uncaughtException", "unhandledRejection"]) {
  process.on(event, (error) => {
    console.error(error);
    annotate(error?.message ?? error);
    process.exit(1);
  });
}

// Locally (and in the PR job) the seed's municipalities, served by `next start` on
// *.localhost; after a deployment, LIGHTHOUSE_ORIGINS lists the real portals, e.g.
// "demo-norte=https://rikuy-demo-norte.vercel.app,otro=https://otro-portal.vercel.app".
// Each portal's pages come from its own sitemap (Hito · Paso 3): its first destination and
// its first upcoming event, whatever they are; a portal without them skips those pages.
//
// A portal with neither (nothing published yet, like a municipality just set up) carries
// `noindex` on purpose (Hito · Paso 1): its SEO is judged without the crawlability audit.
// A portal with content is judged on all of it, so an unwanted `noindex` still fails.
const SEED_PORTALS = ["demo-norte", "demo-sur"];
const origins = new Map(
  (process.env.LIGHTHOUSE_ORIGINS ?? "")
    .split(",")
    .map((pair) => pair.trim().split("="))
    .filter(([slug, origin]) => slug && origin),
);
const originOf = (slug) =>
  (origins.get(slug) ?? `http://${slug}.localhost:${port}`).replace(/\/$/u, "");
const SET = process.env.LIGHTHOUSE_SET === "tours" ? "tours" : "portal";
const measured = origins.size > 0 ? [...origins.keys()] : SEED_PORTALS;
const pageOf = (slug, kind, path, empty = false) => {
  const url = `${originOf(slug)}${path}`;
  return { kind, label: url.replace(/^https?:\/\//u, ""), url, empty };
};

/**
 * GET a page as text. `*.localhost` is not resolved by every system's DNS (Chrome resolves it
 * itself): those go to 127.0.0.1 with their Host header.
 */
async function get(url) {
  const target = new URL(url);
  if (!target.hostname.endsWith(".localhost")) {
    const response = await fetch(url);
    return { status: response.status, text: await response.text() };
  }
  return new Promise((resolve, reject) => {
    const call = httpRequest(
      {
        host: "127.0.0.1",
        port: target.port || 80,
        path: target.pathname + target.search,
        headers: { host: target.host },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => resolve({ status: response.statusCode, text }));
      },
    );
    call.on("error", reject);
    call.end();
  });
}

/** The paths a portal's sitemap lists. */
async function sitemapPaths(slug) {
  const response = await get(`${originOf(slug)}/sitemap.xml`);
  if (response.status !== 200) throw new Error(`${slug}: sitemap answered ${response.status}`);
  return [...response.text.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(
    ([, loc]) => new URL(loc).pathname,
  );
}

/** A portal's tour pages, from its sitemap: the first tour and the general tour. */
async function tourPages(slug) {
  const paths = await sitemapPaths(slug);
  const tour = paths.find((path) => /^\/(destinos|agenda)\/[^/]+\/tour$/u.test(path));
  return tour && paths.includes("/recorrido")
    ? [pageOf(slug, "tour", tour), pageOf(slug, "generalTour", "/recorrido")]
    : [];
}

/** A portal's pages of each kind, from its sitemap (one of each). */
async function portalPages(slug) {
  const paths = await sitemapPaths(slug);
  const first = (pattern) => paths.find((path) => pattern.test(path));
  const empty = !paths.some((path) => /^\/(destinos|agenda)\/[^/]+$/u.test(path));
  const kinds = {
    home: "/",
    destinations: "/destinos",
    destination: first(/^\/destinos\/[^/]+$/u),
    agenda: "/agenda",
    event: first(/^\/agenda\/[^/]+$/u),
    map: "/mapa",
  };
  return Object.entries(kinds)
    .filter(([, path]) => path !== undefined)
    .map(([kind, path]) => pageOf(slug, kind, path, empty));
}

const pages = (
  await Promise.all(measured.map((slug) => (SET === "tours" ? tourPages(slug) : portalPages(slug))))
).flat();
if (pages.length === 0) {
  const message = "no tour pages in the sitemaps: nothing to measure";
  if (process.env.LIGHTHOUSE_REQUIRE_TOURS === "1") throw new Error(message);
  console.log(`lighthouse: ${message}`);
  annotate(message, "warning");
  process.exit(0);
}

// A fresh headless Chrome (new profile, empty cache) for every run: otherwise scripts cached
// by the previous page make the next one look lighter and faster than a first visit is.
async function startChrome() {
  const profile = await mkdtemp(join(tmpdir(), "rikuy-lh-"));
  const debugPort = 9300 + Math.floor(Math.random() * 500);
  const chrome = spawn(
    executablePath,
    [
      "--headless=new",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--no-sandbox",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  // Chrome's own complaints, to explain a failed start.
  let stderr = "";
  chrome.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  let spawnError = null;
  chrome.once("error", (error) => {
    spawnError = error;
  });
  for (let i = 0; ; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      break;
    } catch {
      if (spawnError || chrome.exitCode !== null || i > 150) {
        chrome.kill();
        await rm(profile, { recursive: true, force: true }).catch(() => {});
        const reason =
          spawnError?.message ??
          (chrome.exitCode !== null ? `exit ${chrome.exitCode}` : "no answer in 30 s");
        throw new Error(`Chrome (${executablePath}) did not start: ${reason}\n${stderr.trim()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return {
    port: debugPort,
    async stop() {
      chrome.kill();
      await new Promise((resolve) => chrome.once("exit", resolve));
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/**
 * The SEO score without `is-crawlable`, weighted as Lighthouse weighs the category: for an
 * empty portal, whose `noindex` is intended.
 */
function seoWithoutCrawlability(lhr) {
  let total = 0;
  let weights = 0;
  for (const { id, weight } of lhr.categories.seo?.auditRefs ?? []) {
    const audit = lhr.audits[id];
    if (id === "is-crawlable" || weight === 0 || audit?.score === null || audit === undefined) {
      continue;
    }
    total += audit.score * weight;
    weights += weight;
  }
  return weights === 0 ? 0 : Math.round((total / weights) * 100);
}

function measure(lhr, page) {
  const intendedNoindex = page.empty && lhr.audits["is-crawlable"]?.score === 0;
  const scripts = lhr.audits["resource-summary"]?.details?.items?.find(
    (item) => item.resourceType === "script",
  );
  return {
    scores: Object.fromEntries(
      CATEGORIES.map((id) => [
        id,
        id === "seo" && intendedNoindex
          ? seoWithoutCrawlability(lhr)
          : Math.round((lhr.categories[id]?.score ?? 0) * 100),
      ]),
    ),
    intendedNoindex,
    lcpMs: Math.round(lhr.audits["largest-contentful-paint"].numericValue),
    tbtMs: Math.round(lhr.audits["total-blocking-time"].numericValue),
    cls: Number(lhr.audits["cumulative-layout-shift"].numericValue.toFixed(3)),
    scriptKb: Math.round((scripts?.transferSize ?? 0) / 1024),
    ttfbMs: Math.round(lhr.audits["server-response-time"]?.numericValue ?? 0),
    // Where the LCP time goes (time to first byte, load delay and duration, render delay).
    lcpPhases: (lhr.audits["lcp-breakdown-insight"]?.details?.items?.[0]?.items ?? [])
      .map((item) => `${item.subpart}=${Math.round(item.duration)}`)
      .join(" "),
  };
}

/** One Lighthouse run in a fresh Chrome; a failed run (a hiccup right after a deployment,
 * Chrome not answering) is retried once before giving up. */
async function runOnce(page) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const chrome = await startChrome();
      const result = await lighthouse(page.url, {
        port: chrome.port,
        output: "json",
        logLevel: "error",
        onlyCategories: CATEGORIES,
      }).finally(() => chrome.stop());
      if (!result?.lhr || result.lhr.runtimeError) {
        throw new Error(result?.lhr?.runtimeError?.message ?? "Lighthouse returned no result");
      }
      return result;
    } catch (error) {
      lastError = error;
      console.warn(`${page.label}: attempt ${attempt} failed: ${error.message}`);
    }
  }
  throw new Error(`${page.label}: ${lastError.message}`);
}

// After a deployment the CDN still holds the previous pages: one plain visit to each lets
// it regenerate them, so the runs measure what visitors get, not the regeneration. Tour pages
// were published after the build, so the first visit generates them: warm them too.
if (origins.size > 0 || SET === "tours") {
  for (const page of pages) {
    const response = await get(page.url).catch((error) => ({ status: error.message }));
    if (response.status !== 200) {
      throw new Error(`${page.label}: answered ${response.status} before measuring`);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}

await mkdir(OUT, { recursive: true });
const rows = [];
const problems = [];
{
  for (const page of pages) {
    const runs = [];
    for (let run = 0; run < budget.runs; run += 1) {
      const result = await runOnce(page);
      runs.push({ lhr: result.lhr, report: result.report, ...measure(result.lhr, page) });
    }
    // The run with the median performance score represents the page (as Lighthouse CI does).
    const target = median(runs.map((r) => r.scores.performance));
    const chosen = runs.find((r) => r.scores.performance === target) ?? runs[0];
    await writeFile(
      new URL(`${page.label.replace(/[^a-z0-9]+/giu, "_")}.json`, OUT),
      chosen.report,
    );

    const limits = budget.pages[page.kind];
    const fail = [];
    if (limits.performance !== null && chosen.scores.performance < limits.performance) {
      fail.push(`performance ${chosen.scores.performance} < ${limits.performance}`);
    }
    for (const [id, min] of Object.entries(budget.categories)) {
      if (chosen.scores[id] < min) fail.push(`${id} ${chosen.scores[id]} < ${min}`);
    }
    if (limits.lcpMs !== null && chosen.lcpMs > limits.lcpMs) {
      fail.push(`LCP ${chosen.lcpMs} ms > ${limits.lcpMs} ms`);
    }
    if (limits.cls !== null && chosen.cls > limits.cls)
      fail.push(`CLS ${chosen.cls} > ${limits.cls}`);
    if (limits.scriptKb !== null && chosen.scriptKb > limits.scriptKb) {
      fail.push(`JS ${chosen.scriptKb} KB > ${limits.scriptKb} KB`);
    }
    if (fail.length > 0) problems.push(`${page.label}: ${fail.join(", ")}`);
    rows.push({ page, chosen, runs: runs.map((r) => r.scores.performance), ok: fail.length === 0 });
    console.log(
      `${fail.length === 0 ? "✓" : "✗"} ${page.label} perf ${chosen.scores.performance} [${runs
        .map((r) => r.scores.performance)
        .join(
          ", ",
        )}] a11y ${chosen.scores.accessibility} bp ${chosen.scores["best-practices"]} seo ${
        chosen.scores.seo
      }${chosen.intendedNoindex ? " (noindex: portal vacío)" : ""} LCP ${chosen.lcpMs} ms TBT ${chosen.tbtMs} ms CLS ${chosen.cls} JS ${chosen.scriptKb} KB`,
    );
  }
}

const table = [
  "| Página | Rendimiento (3 corridas) | Accesibilidad | Buenas prácticas | SEO | LCP | TBT | CLS | JS | |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ...rows.map(
    ({ page, chosen, runs, ok }) =>
      `| ${page.label} | ${chosen.scores.performance} (${runs.join(", ")}) | ${chosen.scores.accessibility} | ${
        chosen.scores["best-practices"]
      } | ${chosen.scores.seo}${chosen.intendedNoindex ? " (noindex: portal vacío)" : ""} | ${(chosen.lcpMs / 1000).toFixed(1)} s | ${chosen.tbtMs} ms | ${chosen.cls} | ${
        chosen.scriptKb
      } KB | ${ok ? "✅" : "❌"} |`,
  ),
].join("\n");
if (process.env.GITHUB_STEP_SUMMARY) {
  const where = origins.size > 0 ? "sitio publicado" : "compilación del PR";
  const what = SET === "tours" ? "tours 360°" : "portal";
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `## Lighthouse (móvil, ${what}, ${where})\n\n${table}\n`,
  );
}

// Every page's numbers as one annotation: readable on the PR even when logs and artifacts
// cannot be downloaded, and comparable between runs.
annotate(
  rows
    .map(
      ({ page, chosen, runs }) =>
        `${page.label} perf ${chosen.scores.performance} [${runs.join(", ")}] LCP ${chosen.lcpMs} TTFB ${chosen.ttfbMs} TBT ${chosen.tbtMs} · ${chosen.lcpPhases}`,
    )
    .join("\n"),
  "notice",
);

if (problems.length > 0) {
  console.error(`\nOver budget:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  annotate(`Over budget:\n${problems.join("\n")}`);
  process.exit(1);
}
console.log(`lighthouse: ${rows.length} pages within budget`);
