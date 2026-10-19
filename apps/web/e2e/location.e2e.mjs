// RC-06 · visitor location in a real browser (ADR-021), against one running build (`next start`)
// backed by the local Supabase stack with the seed. Checks the three permission states
// (granted, denied, unknown), that nothing is asked before the visitor presses the button,
// that every page works without a position, and that no request carries the position.
//
// Usage: CHROME_PATH=/path/to/chrome node e2e/location.e2e.mjs [port]
//   (CI job "Integration · real Supabase stack"; GitHub runners ship Google Chrome)
import { strict as assert } from "node:assert";

import { chromium } from "playwright-core";

const port = Number(process.argv[2] ?? 3000);
const NORTE = `http://demo-norte.localhost:${port}`;
const executablePath = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";

// Distinctive coordinates: if any of these digits shows up in a request, the position leaked.
const NEAR_MIRADOR = { latitude: -17.39047, longitude: -66.15083, accuracy: 15 };
const NEAR_PLAZA = { latitude: -17.39512, longitude: -66.15547, accuracy: 15 };

// The map style is replaced by a blank one: the test needs no tiles and no internet.
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

/**
 * A fresh visitor. `permission`: "granted" | "denied" | "prompt" (never answered).
 * Every geolocation call is counted (window.__geoCalls) and every request recorded.
 */
async function visitor({ permission, geolocation, noPermissionsApi = false, mobile = false }) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    ...(geolocation ? { geolocation } : {}),
    ...(permission === "granted" ? { permissions: ["geolocation"] } : {}),
  });
  if (permission === "denied") {
    const session = await browser.newBrowserCDPSession();
    const { browserContextIds } = await session.send("Target.getBrowserContexts");
    for (const browserContextId of browserContextIds) {
      await session.send("Browser.setPermission", {
        permission: { name: "geolocation" },
        setting: "denied",
        browserContextId,
      });
    }
  }
  await context.addInitScript((removePermissions) => {
    window.__geoCalls = 0;
    const geo = navigator.geolocation;
    for (const method of ["watchPosition", "getCurrentPosition"]) {
      const original = geo[method].bind(geo);
      geo[method] = (...args) => {
        window.__geoCalls += 1;
        return original(...args);
      };
    }
    if (removePermissions) delete Navigator.prototype.permissions;
  }, noPermissionsApi);
  await context.route("https://tiles.openfreemap.org/**", (route) =>
    route.request().url().includes("/styles/")
      ? route.fulfill({ contentType: "application/json", body: BLANK_STYLE })
      : route.abort(),
  );
  const page = await context.newPage();
  const requests = [];
  page.on("request", (request) =>
    requests.push({ url: request.url(), body: request.postData() ?? "" }),
  );
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { context, page, requests, errors };
}

/** The visitor's dot is inside the visible map (no need to pan or zoom to find it). */
async function assertDotOnScreen(page) {
  await page.waitForTimeout(1500); // camera animation
  const frame = await page.locator(".portal-map-frame").boundingBox();
  const dot = await page.locator(".map-visitor").boundingBox();
  assert.ok(frame && dot, "map and dot are rendered");
  const x = dot.x + dot.width / 2;
  const y = dot.y + dot.height / 2;
  assert.ok(
    x > frame.x && x < frame.x + frame.width && y > frame.y && y < frame.y + frame.height,
    `dot at ${Math.round(x)},${Math.round(y)} outside the map ${JSON.stringify(frame)}`,
  );
}

const geoCalls = (page) => page.evaluate(() => window.__geoCalls);

/** "A 80 m en línea recta" / "A 1,2 km en línea recta" → meters. */
function meters(line) {
  const match = /A ([\d.,]+) (k?m)/u.exec(line);
  assert.ok(match, `not a distance: ${line}`);
  const value = Number(match[1].replace(/\./gu, "").replace(",", "."));
  return match[2] === "km" ? value * 1000 : value;
}

function assertAscending(lines) {
  const values = lines.map(meters);
  for (let i = 1; i < values.length; i += 1) {
    assert.ok(values[i] >= values[i - 1], `not sorted by distance: ${lines.join(" / ")}`);
  }
}
const texts = (locator) => locator.allInnerTexts();

/** No request (URL or body) and no browser storage holds the visitor's coordinates. */
async function assertNoLeak(page, requests, position) {
  const needles = [position.latitude, position.longitude].flatMap((value) => [
    value.toFixed(4),
    value.toFixed(3),
  ]);
  const leaked = requests.filter((request) =>
    needles.some((needle) => request.url.includes(needle) || request.body.includes(needle)),
  );
  assert.deepEqual(
    leaked.map((request) => request.url),
    [],
    "requests carrying the position",
  );
  const stored = await page.evaluate(() =>
    JSON.stringify([{ ...window.sessionStorage }, { ...window.localStorage }]),
  );
  for (const needle of needles) assert.ok(!stored.includes(needle), `storage holds ${needle}`);
}

// ── Unknown: the prompt is never answered ──────────────────────────────────────
{
  const { context, page, requests, errors } = await visitor({
    permission: "prompt",
    geolocation: NEAR_PLAZA,
  });
  await check("unknown · nothing is asked on load (map, list, page)", async () => {
    for (const path of ["/mapa", "/destinos", "/destinos/mirador-del-valle", "/agenda"]) {
      await page.goto(`${NORTE}${path}`);
      await page.waitForLoadState("networkidle");
      assert.equal(await geoCalls(page), 0, `${path} asked for the position on load`);
    }
  });
  await check("unknown · pressing the button asks once and the page keeps working", async () => {
    await page.goto(`${NORTE}/destinos`);
    const order = await texts(page.locator(".portal-card-title"));
    await page.getByRole("button", { name: "Ordenar por cercanía" }).click();
    await page.waitForTimeout(500);
    assert.equal(await geoCalls(page), 1);
    // Still waiting for an answer, or — as recent headless Chrome does with an unanswered
    // prompt — dismissed and reported as refused. Either way the page says so in words.
    assert.match(
      await page.locator(".portal-location-status").innerText(),
      /Buscando tu ubicación|No tenemos permiso/u,
    );
    assert.deepEqual(await texts(page.locator(".portal-card-title")), order);
    assert.equal(await page.locator(".portal-distance").count(), 0);
  });
  await check("unknown · no request carries the position", () =>
    assertNoLeak(page, requests, NEAR_PLAZA),
  );
  await check("unknown · no page errors", () => assert.deepEqual(errors, []));
  await context.close();
}

// ── Granted, on the map next to a destination ──────────────────────────────────
{
  const { context, page, requests, errors } = await visitor({
    permission: "granted",
    geolocation: NEAR_MIRADOR,
  });
  await page.goto(`${NORTE}/mapa`);
  await page.locator(".maplibregl-canvas").waitFor({ timeout: 20_000 });
  // Let the first view settle (its own area request, if any, is not about the visitor).
  await page.waitForTimeout(1500);
  await page.waitForLoadState("networkidle");

  await check("granted · even with permission, nothing is asked before the button", async () => {
    assert.equal(await geoCalls(page), 0);
    assert.equal(await page.locator(".map-visitor").count(), 0);
  });

  const beforeLocation = requests.length;
  await page.getByRole("button", { name: "Usar mi ubicación" }).click();
  await page.locator(".map-visitor").waitFor({ timeout: 10_000 });

  await check("granted · the map shows the visitor and follows them", async () => {
    await assertDotOnScreen(page);
    assert.equal(
      await page
        .getByRole("button", { name: /Siguiéndote|Seguirme/u })
        .getAttribute("aria-pressed"),
      "true",
    );
  });
  await check("granted · «Estás cerca de…» announces the destination in its radius", async () => {
    await page.locator(".portal-nearby-card").waitFor({ timeout: 5000 });
    assert.match(
      await page.locator(".portal-nearby").innerText(),
      /Estás cerca de\s+Mirador del Valle · a \d+ m en línea recta/u,
    );
  });
  await check(
    "granted · the list goes from the closest to the farthest, with distances",
    async () => {
      const items = await texts(page.locator(".portal-map-list li .portal-map-title"));
      const distances = await texts(page.locator(".portal-map-list li .portal-distance"));
      assert.equal(distances.length, items.length);
      for (const line of distances) assert.match(line, /^A [\d.,]+ k?m en línea recta$/u);
      assertAscending(distances);
      assert.ok(items.indexOf("Mirador del Valle") < items.indexOf("Plaza principal"));
      assert.match(await page.locator(".portal-map-count").innerText(), /del más cercano/u);
    },
  );
  await check("granted · zooming while following asks the server for nothing", async () => {
    await page.getByRole("button", { name: "Alejar" }).click();
    await page.waitForTimeout(700);
    await page.getByRole("button", { name: "Alejar" }).click();
    await page.waitForTimeout(1200);
    const areaRequests = requests
      .slice(beforeLocation)
      .filter((request) => request.url.includes("/mapa/lugares"));
    assert.deepEqual(areaRequests, []);
  });
  await check("granted · dragging the map stops following", async () => {
    const frame = await page.locator(".portal-map-frame").boundingBox();
    assert.ok(frame);
    await page.mouse.move(frame.x + 60, frame.y + 120);
    await page.mouse.down();
    await page.mouse.move(frame.x + 220, frame.y + 200, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    assert.equal(
      await page
        .getByRole("button", { name: /Siguiéndote|Seguirme/u })
        .getAttribute("aria-pressed"),
      "false",
    );
  });
  await check("granted · «Dejar de usar mi ubicación» removes the dot and the notice", async () => {
    await page.getByRole("button", { name: "Dejar de usar mi ubicación" }).click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".map-visitor").count(), 0);
    assert.equal(await page.locator(".portal-nearby-card").count(), 0);
    assert.equal(await page.locator(".portal-map-list .portal-distance").count(), 0);
  });
  await check("granted · no request carries the position", () =>
    assertNoLeak(page, requests, NEAR_MIRADOR),
  );
  await check("granted · no page errors", () => assert.deepEqual(errors, []));
  await context.close();
}

// ── Granted: lists, pages and the agenda ───────────────────────────────────────
{
  const { context, page, requests, errors } = await visitor({
    permission: "granted",
    geolocation: NEAR_PLAZA,
  });
  await page.goto(`${NORTE}/destinos`);
  const original = await texts(page.locator(".portal-card-title"));
  await check("granted · destinations keep the municipality's order until asked", async () => {
    assert.ok(original.includes("Mirador del Valle") && original.includes("Plaza principal"));
    assert.ok(original.indexOf("Mirador del Valle") < original.indexOf("Plaza principal"));
    assert.equal(await page.locator(".portal-distance").count(), 0);
  });
  await page.getByRole("button", { name: "Ordenar por cercanía" }).click();
  await check("granted · «Ordenar por cercanía» puts the closest first", async () => {
    await page.locator(".portal-card .portal-distance").first().waitFor();
    const sorted = await texts(page.locator(".portal-card-title"));
    assert.equal(sorted[0], "Plaza principal");
    assert.deepEqual([...sorted].sort(), [...original].sort());
    assertAscending(await texts(page.locator(".portal-card .portal-distance")));
    assert.match(await page.locator(".portal-proximity-note").innerText(), /cercanía/u);
  });
  await check("granted · the next page resumes without asking again", async () => {
    await page.goto(`${NORTE}/destinos/mirador-del-valle`);
    const line = page.locator(".portal-location-visitor .portal-distance");
    await line.waitFor({ timeout: 5000 });
    assert.match(
      await line.innerText(),
      /A [\d.,]+ k?m en línea recta\s+~\d+ min a pie · ~\d+ min en auto \(estimado\)/u,
    );
  });
  await check("granted · the agenda can be sorted by distance", async () => {
    await page.goto(`${NORTE}/agenda`);
    await page.getByLabel("Por cercanía").check();
    const events = await texts(page.locator(".portal-events .portal-event-title"));
    assert.ok(events.includes("Feria del choclo"));
    assert.equal(await page.locator(".portal-month").count(), 0);
    await page.getByLabel("Por fecha").check();
    assert.ok((await page.locator(".portal-month").count()) > 0);
  });
  await check("granted · only the choice is remembered, never the position", async () => {
    const stored = await page.evaluate(() => ({ ...window.sessionStorage }));
    assert.deepEqual(stored, { "rikuy:location": "on" });
  });
  await check("granted · no request carries the position", () =>
    assertNoLeak(page, requests, NEAR_PLAZA),
  );
  await check("granted · no page errors", () => assert.deepEqual(errors, []));
  await context.close();
}

// ── Granted, ~33 km away from the municipality's places ───────────────────────
{
  const FAR = { latitude: -17.58731, longitude: -65.93417, accuracy: 20 };
  const { context, page, requests, errors } = await visitor({
    permission: "granted",
    geolocation: FAR,
  });
  await page.goto(`${NORTE}/mapa`);
  await page.locator(".maplibregl-canvas").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  await page.waitForLoadState("networkidle");
  const beforeLocation = requests.length;
  await page.getByRole("button", { name: "Usar mi ubicación" }).click();
  await page.locator(".map-visitor").waitFor({ timeout: 10_000 });
  await check("far · the map frames the visitor right away, with the places", async () => {
    await assertDotOnScreen(page);
    assert.match(await page.locator(".portal-map-far").innerText(), /Estás a \d+ km de esta zona/u);
    assert.ok((await page.locator(".portal-map-list li").count()) >= 3);
  });
  await check("far · framing the visitor asks the server for nothing", async () => {
    const areaRequests = requests
      .slice(beforeLocation)
      .filter((request) => request.url.includes("/mapa/lugares"));
    assert.deepEqual(areaRequests, []);
  });
  await check("far · «Seguirme» is offered and centers on the visitor", async () => {
    await page.getByRole("button", { name: "Seguirme" }).click();
    await assertDotOnScreen(page);
    assert.equal(
      await page.getByRole("button", { name: "Siguiéndote" }).getAttribute("aria-pressed"),
      "true",
    );
  });
  await check("far · no request carries the position", () => assertNoLeak(page, requests, FAR));
  await check("far · no page errors", () => assert.deepEqual(errors, []));
  await context.close();
}

// ── Denied ─────────────────────────────────────────────────────────────────────
{
  const { context, page, requests, errors } = await visitor({
    permission: "denied",
    geolocation: NEAR_PLAZA,
  });
  await page.goto(`${NORTE}/destinos`);
  const order = await texts(page.locator(".portal-card-title"));
  await page.getByRole("button", { name: "Ordenar por cercanía" }).click();
  await check("denied · says so and offers to try again", async () => {
    await page.getByRole("button", { name: "Intentar de nuevo" }).waitFor({ timeout: 5000 });
    assert.match(
      await page.locator(".portal-location-status").innerText(),
      /No tenemos permiso.*todo funciona igual/u,
    );
  });
  await check("denied · everything still works, in the municipality's order", async () => {
    assert.deepEqual(await texts(page.locator(".portal-card-title")), order);
    assert.equal(await page.locator(".portal-distance").count(), 0);
    await page.goto(`${NORTE}/mapa`);
    await page.locator(".maplibregl-canvas").waitFor({ timeout: 20_000 });
    assert.ok((await page.locator(".portal-map-list li").count()) >= 3);
    assert.equal(await geoCalls(page), 0, "a refused permission is not asked again on load");
  });
  await check("denied · no request carries the position", () =>
    assertNoLeak(page, requests, NEAR_PLAZA),
  );
  await check("denied · no page errors", () => assert.deepEqual(errors, []));
  await context.close();
}

// ── Unknown permission state (no Permissions API, as in older Safari) ──────────
{
  const { context, page, requests, errors } = await visitor({
    permission: "granted",
    geolocation: NEAR_PLAZA,
    noPermissionsApi: true,
    mobile: true,
  });
  await page.goto(`${NORTE}/destinos`);
  await page.getByRole("button", { name: "Ordenar por cercanía" }).click();
  await check("no Permissions API · works after the button", async () => {
    await page.locator(".portal-card .portal-distance").first().waitFor({ timeout: 5000 });
    assert.equal((await texts(page.locator(".portal-card-title")))[0], "Plaza principal");
  });
  await check("no Permissions API · the next page does not resume on its own", async () => {
    await page.goto(`${NORTE}/destinos/plaza-principal`);
    await page.waitForLoadState("networkidle");
    assert.equal(await geoCalls(page), 0);
  });
  await check("phone · activating on /mapa brings the map and the dot into view", async () => {
    await page.goto(`${NORTE}/mapa`);
    await page.locator(".maplibregl-canvas").waitFor({ timeout: 20_000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByRole("button", { name: "Usar mi ubicación" }).click();
    await page.locator(".map-visitor").waitFor({ timeout: 10_000 });
    await assertDotOnScreen(page);
    const dot = await page.locator(".map-visitor").boundingBox();
    const height = await page.evaluate(() => window.innerHeight);
    assert.ok(dot && dot.y > 0 && dot.y < height, "the dot is within the phone screen");
  });
  await check("no Permissions API · no horizontal overflow on a phone", async () => {
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      false,
    );
  });
  await check("no Permissions API · no request carries the position", () =>
    assertNoLeak(page, requests, NEAR_PLAZA),
  );
  await check("no Permissions API · no page errors", () => assert.deepEqual(errors, []));
  await context.close();
}

await browser.close();
console.log(`location e2e: ${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
