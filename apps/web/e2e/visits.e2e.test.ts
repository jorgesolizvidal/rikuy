/**
 * C1 · Paso 1 (ADR-051) in a real browser against the local stack: the portal counts what a
 * visitor opens and does, anonymously.
 *
 * - opening pages counts a view of each (the home page and a place, by its content);
 * - a QR scan (`?qr=1`) counts apart, and the mark leaves the address;
 * - «Cómo llegar» and «Compartir» count on their place;
 * - a second visit the same day is a view, not a new visitor;
 * - a headless browser (a robot) counts nothing, and a beacon from another site is refused;
 * - no cookie and nothing in the browser's storage.
 */
import { request as httpRequest } from "node:http";

import { chromium, type Browser, type BrowserContext } from "playwright-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PORT = Number(process.env.RIKUY_PORT ?? 3000);
const SUR_HOST = `demo-sur.localhost:${PORT}`;
const SUR_PORTAL = `http://${SUR_HOST}`;
const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SUR = "5eed1000-0000-4000-8000-000000000002";
const PLACE = "laguna-espejo";
// A visitor's phone (the default headless agent is a robot for the counts).
const PHONE =
  "Mozilla/5.0 (Linux; Android 15; CRT-NX3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";

const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
let browser: Browser;

interface Count {
  readonly target: string;
  readonly event: string;
  readonly views: number;
  readonly visitors: number;
}

/** Today's totals of Demo Sur, in the municipality's day. */
async function counts(): Promise<Map<string, Count>> {
  const rows = await db<Count[]>`
    select c.target, c.event, sum(c.views)::int as views, sum(c.visitors)::int as visitors
    from public.visit_daily_counts c
    left join public.content_items i on i.id = c.content_id
    where c.tenant_id = ${SUR}::uuid
      and c.day = (now() at time zone 'America/La_Paz')::date
      and (c.content_id is null or i.slug = ${PLACE})
    group by c.target, c.event`;
  return new Map(rows.map((row) => [`${row.target}:${row.event}`, row]));
}

function delta(before: Map<string, Count>, after: Map<string, Count>, key: string) {
  return {
    views: (after.get(key)?.views ?? 0) - (before.get(key)?.views ?? 0),
    visitors: (after.get(key)?.visitors ?? 0) - (before.get(key)?.visitors ?? 0),
  };
}

/** The beacons are written after the response: wait until the totals stop changing. */
async function settled(): Promise<Map<string, Count>> {
  let last = JSON.stringify([...(await counts())]);
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const now = JSON.stringify([...(await counts())]);
    if (now === last && i > 2) break;
    last = now;
  }
  return counts();
}

/** A beacon sent by hand (127.0.0.1 with the portal's Host: not every system resolves it). */
function beacon(origin: string, body: object): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: PORT,
        path: "/visita",
        method: "POST",
        headers: { host: SUR_HOST, origin, "user-agent": PHONE, "content-type": "text/plain" },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

async function visitor(userAgent?: string): Promise<BrowserContext> {
  return browser.newContext({
    ...(userAgent ? { userAgent } : {}),
    viewport: { width: 390, height: 844 },
  });
}

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: CHROME });
  // Each run is a new visitor: clear today's marks of Demo Sur (they are only hashes).
  await db`delete from private.visit_marks where tenant_id = ${SUR}::uuid`;
});

afterAll(async () => {
  await browser?.close();
  await db.end({ timeout: 5 });
});

describe("anonymous visit counts (ADR-051)", () => {
  it("counts pages, a QR scan and the place's actions, without cookies", async () => {
    const before = await counts();
    const context = await visitor(PHONE);
    const page = await context.newPage();
    const beacons: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/visita")) beacons.push(request.postData() ?? "");
    });

    // The page counts itself once it is hydrated: leaving right after «load» can take the
    // beacon with it, so wait for it before going on.
    const sent = () => page.waitForRequest((request) => request.url().endsWith("/visita"));
    const home = sent();
    await page.goto(`${SUR_PORTAL}/`, { waitUntil: "load" });
    await home;
    await page.goto(`${SUR_PORTAL}/destinos/${PLACE}?qr=1`, { waitUntil: "load" });
    await expect.poll(() => new URL(page.url()).search).toBe("");

    // «Cómo llegar» opens the maps app in another tab: keep it from leaving the test.
    await context.route(/google\.com|openstreetmap/u, (route) => route.abort());
    const popup = context.waitForEvent("page");
    await page
      .getByRole("link", { name: /Cómo llegar/u })
      .first()
      .click();
    await (await popup).close();
    await page.evaluate(() => {
      // No share sheet nor clipboard in a headless browser: the click is what counts.
      Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
    });
    await page.getByRole("button", { name: "Compartir" }).click();

    // A second visit to the same place the same day.
    await page.goto(`${SUR_PORTAL}/destinos/${PLACE}`, { waitUntil: "load" });

    const after = await settled();
    expect(delta(before, after, "home:view")).toEqual({ views: 1, visitors: 1 });
    expect(delta(before, after, "destination:view")).toEqual({ views: 2, visitors: 1 });
    expect(delta(before, after, "destination:qr")).toEqual({ views: 1, visitors: 1 });
    expect(delta(before, after, "destination:directions")).toEqual({ views: 1, visitors: 1 });
    expect(delta(before, after, "destination:share")).toEqual({ views: 1, visitors: 1 });

    // What the browser sent: what it opened, never who the visitor is (a beacon's body is
    // not always visible to the test; the ones that are say only the page and the event).
    expect(beacons.length).toBeGreaterThanOrEqual(6);
    for (const beacon of beacons.filter((body) => body.length > 0)) {
      expect(["event", "path", "scene"]).toEqual(
        expect.arrayContaining(Object.keys(JSON.parse(beacon) as object)),
      );
    }
    expect(await context.cookies()).toEqual([]);
    expect(
      await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
    ).toEqual({ local: 0, session: 0 });
    await context.close();
  });

  it("does not count robots, nor beacons from another site", async () => {
    const before = await counts();
    const robot = await visitor(); // HeadlessChrome
    const page = await robot.newPage();
    await page.goto(`${SUR_PORTAL}/destinos/${PLACE}`, { waitUntil: "load" });
    await robot.close();

    expect(
      await beacon("https://otro-sitio.example", { path: `/destinos/${PLACE}`, event: "view" }),
    ).toBe(403);
    expect(await beacon(SUR_PORTAL, { path: "/destinos/no-existe", event: "view" })).toBe(204);

    const after = await settled();
    expect(delta(before, after, "destination:view")).toEqual({ views: 0, visitors: 0 });
  });
});
