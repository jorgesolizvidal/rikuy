// End-to-end check of the white-label portals on ONE running build (`next start`) backed by
// the real local Supabase stack with the seed: two municipalities, two brands, same code.
// Usage: node e2e/portals.e2e.mjs [port]   (CI job "Integration · real Supabase stack")
import { strict as assert } from "node:assert";
import http from "node:http";
import { createRequire } from "node:module";

const port = Number(process.argv[2] ?? 3000);
// After the integration suite, the ZC-01 rehearsal tenant exists and must be live too.
const zc01 = process.argv.includes("--zc01");
// After the integration suite, Demo Norte has a published logo (media.int.test.ts).
const withLogo = process.argv.includes("--logo");

function get(host, path) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: "127.0.0.1", port, path, headers: { host: `${host}:${port}` } },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.on("error", reject);
    request.setTimeout(15_000, () => request.destroy(new Error(`timeout ${host}${path}`)));
  });
}

const portals = [
  {
    host: "demo-norte.localhost",
    name: "Municipio Demo Norte",
    brand: "#1f6f4a",
    mode: "light",
    logo: withLogo,
    destination: { slug: "mirador-del-valle", title: "Mirador del Valle", lat: -17.3901 },
    hidden: ["laguna-espejo", "feria-de-los-domingos"],
    event: { slug: "feria-del-choclo", title: "Feria del choclo", allDay: false },
    hiddenEvents: ["concierto-de-la-banda", "noche-de-estrellas"],
    endedEvent: "festival-de-invierno",
  },
  {
    host: "demo-sur.localhost",
    name: "Municipio Demo Sur",
    brand: "#f0a868",
    mode: "dark",
    logo: false,
    destination: { slug: "laguna-espejo", title: "Laguna Espejo", lat: -21.5302 },
    hidden: ["mirador-del-valle", "feria-de-los-domingos"],
    event: { slug: "noche-de-estrellas", title: "Noche de estrellas", allDay: true },
    hiddenEvents: ["feria-del-choclo", "concierto-de-la-banda", "festival-de-invierno"],
    endedEvent: null,
  },
];

let checks = 0;
const check = (fn) => {
  fn();
  checks += 1;
};

for (const portal of portals) {
  const home = await get(portal.host, "/");
  const html = home.body.toString();
  check(() => assert.equal(home.status, 200, `${portal.host} home`));
  check(() => assert.match(html, new RegExp(`<title>${portal.name}</title>`)));
  check(() => assert.match(html, new RegExp(`--brand:${portal.brand}`)));
  check(() => assert.match(html, new RegExp(`data-mode="${portal.mode}"`)));
  check(() => assert.match(html, new RegExp(`<meta name="theme-color" content="${portal.brand}"`)));
  check(() => assert.match(html, /<link rel="manifest" href="\/manifest.webmanifest"/));
  // No other tenant's brand leaks into this page.
  for (const other of portals.filter((p) => p !== portal)) {
    check(() => assert.doesNotMatch(html, new RegExp(other.name)));
  }

  // Logo: a versioned public derivative from Storage, or the monogram when there is none.
  const logoSrc = /<img class="portal-logo" src="([^"]+)"/.exec(html)?.[1];
  if (portal.logo) {
    check(() => assert.ok(logoSrc, `${portal.host} shows its logo`));
    check(() =>
      assert.match(
        logoSrc,
        /\/storage\/v1\/object\/public\/media-public\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/\d+\/logo\.webp$/,
      ),
    );
    const image = await fetch(logoSrc);
    check(() => assert.equal(image.status, 200, "logo is publicly reachable"));
    check(() => assert.equal(image.headers.get("content-type"), "image/webp"));
    check(() => assert.match(html, /<meta property="og:image" content="[^"]+\/logo\.png"/));
  } else {
    check(() => assert.equal(logoSrc, undefined, `${portal.host} uses the monogram`));
  }

  const manifest = await get(portal.host, "/manifest.webmanifest");
  check(() => assert.equal(manifest.status, 200));
  check(() =>
    assert.match(String(manifest.headers["content-type"]), /application\/manifest\+json/),
  );
  const parsed = JSON.parse(manifest.body.toString());
  check(() => assert.equal(parsed.name, portal.name));
  check(() => assert.equal(parsed.theme_color, portal.brand));

  const icon = await get(portal.host, parsed.icons[0].src);
  check(() => assert.equal(icon.status, 200));
  check(() => assert.equal(icon.headers["content-type"], "image/png"));
  check(() => assert.match(String(icon.headers["cache-control"]), /immutable/));
}

// Destinations (P3 · Paso 3): each portal lists and renders only its own published ones.
for (const portal of portals) {
  const { slug, title, lat } = portal.destination;
  const others = portals.filter((p) => p !== portal);

  const list = await get(portal.host, "/destinos");
  const listHtml = list.body.toString();
  check(() => assert.equal(list.status, 200, `${portal.host} /destinos`));
  check(() => assert.match(listHtml, new RegExp(`href="/destinos/${slug}"`)));
  for (const hidden of portal.hidden) {
    // Another municipality's destination, or a draft never published.
    check(() => assert.doesNotMatch(listHtml, new RegExp(`/destinos/${hidden}"`)));
  }
  check(() => assert.match(listHtml, /<link rel="canonical" href="[^"]+\/destinos"/));

  const home = (await get(portal.host, "/")).body.toString();
  check(() => assert.match(home, new RegExp(`href="/destinos/${slug}"`), "home lists it"));

  const page = await get(portal.host, `/destinos/${slug}`);
  const html = page.body.toString();
  check(() => assert.equal(page.status, 200, `${portal.host} ficha`));
  check(() => assert.match(html, new RegExp(`<h1[^>]*>${title}</h1>`)));
  check(() =>
    assert.match(
      html,
      new RegExp(`<link rel="canonical" href="http://${portal.host}:${port}/destinos/${slug}"`),
    ),
  );
  check(() => assert.match(html, /<script type="application\/ld\+json">/));
  const jsonLd = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/s.exec(html)[1]);
  check(() => assert.equal(jsonLd["@type"], "TouristAttraction"));
  check(() => assert.equal(jsonLd.geo.latitude, lat));
  check(() =>
    assert.match(html, new RegExp(`google.com/maps/dir/\\?api=1&amp;destination=${lat}`)),
  );
  for (const other of others) check(() => assert.doesNotMatch(html, new RegExp(other.name)));

  // Responsive photos: srcset with real widths and reserved size, when there are any.
  for (const [, srcset] of html.matchAll(/srcSet="([^"]+)"/g)) {
    check(() => assert.match(srcset, /\/w480\.webp 480w/));
  }

  for (const hidden of portal.hidden) {
    const missing = await get(portal.host, `/destinos/${hidden}`);
    check(() => assert.equal(missing.status, 404, `${portal.host} /destinos/${hidden}`));
    check(() => assert.match(missing.body.toString(), /No encontramos esta página/));
  }

  const sitemap = await get(portal.host, "/sitemap.xml");
  const xml = sitemap.body.toString();
  check(() => assert.equal(sitemap.status, 200));
  check(() =>
    assert.match(xml, new RegExp(`<loc>http://${portal.host}:${port}/destinos/${slug}</loc>`)),
  );
  for (const hidden of portal.hidden) check(() => assert.doesNotMatch(xml, new RegExp(hidden)));
  const robots = (await get(portal.host, "/robots.txt")).body.toString();
  check(() =>
    assert.match(robots, new RegExp(`Sitemap: http://${portal.host}:${port}/sitemap.xml`)),
  );

  for (const path of ["/privacidad", "/terminos"]) {
    const legal = await get(portal.host, path);
    check(() => assert.equal(legal.status, 200, `${portal.host}${path}`));
    check(() => assert.match(legal.body.toString(), new RegExp(portal.name)));
  }
}

// Agenda (P3 · Paso 4): upcoming events only, per municipality; ended events keep a page.
for (const portal of portals) {
  const { slug, title, allDay } = portal.event;
  const others = portals.filter((p) => p !== portal);

  const agenda = await get(portal.host, "/agenda");
  const agendaHtml = agenda.body.toString();
  check(() => assert.equal(agenda.status, 200, `${portal.host} /agenda`));
  check(() => assert.match(agendaHtml, new RegExp(`href="/agenda/${slug}"`)));
  for (const hidden of [...portal.hiddenEvents, portal.endedEvent].filter(Boolean)) {
    check(() => assert.doesNotMatch(agendaHtml, new RegExp(`/agenda/${hidden}"`)));
  }
  const home = (await get(portal.host, "/")).body.toString();
  check(() => assert.match(home, new RegExp(`href="/agenda/${slug}"`), "home shows next events"));

  const page = await get(portal.host, `/agenda/${slug}`);
  const html = page.body.toString();
  check(() => assert.equal(page.status, 200, `${portal.host} event page`));
  check(() => assert.match(html, new RegExp(`<h1[^>]*>${title}</h1>`)));
  const jsonLd = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/s.exec(html)[1]);
  check(() => assert.equal(jsonLd["@type"], "Event"));
  check(() => assert.match(html, new RegExp(`href="/agenda/${slug}/calendario.ics"`)));
  for (const other of others) check(() => assert.doesNotMatch(html, new RegExp(other.name)));

  const ics = await get(portal.host, `/agenda/${slug}/calendario.ics`);
  const icsText = ics.body.toString();
  check(() => assert.equal(ics.status, 200));
  check(() => assert.match(String(ics.headers["content-type"]), /text\/calendar/));
  check(() => assert.match(icsText, /BEGIN:VEVENT\r\n/));
  check(() =>
    assert.match(icsText, allDay ? /DTSTART;VALUE=DATE:\d{8}\r\n/ : /DTSTART:\d{8}T\d{6}Z\r\n/),
  );

  for (const hidden of portal.hiddenEvents) {
    const missing = await get(portal.host, `/agenda/${hidden}`);
    check(() => assert.equal(missing.status, 404, `${portal.host} /agenda/${hidden}`));
  }
  if (portal.endedEvent) {
    const ended = (await get(portal.host, `/agenda/${portal.endedEvent}`)).body.toString();
    check(() => assert.match(ended, /Este evento ya terminó/));
    check(() => assert.match(ended, /<meta name="robots" content="noindex, follow"/));
  }

  const xml = (await get(portal.host, "/sitemap.xml")).body.toString();
  check(() => assert.match(xml, new RegExp(`/agenda/${slug}</loc>`)));
  if (portal.endedEvent) check(() => assert.doesNotMatch(xml, new RegExp(portal.endedEvent)));
}

// Map (P3 · Paso 5): places by area, per municipality; MapLibre outside initial bundles.
async function initialScripts(host, path) {
  const html = (await get(host, path)).body.toString();
  const sources = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]);
  const bodies = await Promise.all(
    sources.map(async (src) => (await get(host, src)).body.toString()),
  );
  return bodies;
}

for (const portal of portals) {
  const others = portals.filter((p) => p !== portal);
  const map = await get(portal.host, "/mapa");
  const mapHtml = map.body.toString();
  check(() => assert.equal(map.status, 200, `${portal.host} /mapa`));
  check(() => assert.match(mapHtml, new RegExp(`href="/destinos/${portal.destination.slug}"`)));
  check(() => assert.match(mapHtml, new RegExp(`href="/agenda/${portal.event.slug}"`)));
  for (const other of others) {
    check(() => assert.doesNotMatch(mapHtml, new RegExp(`/destinos/${other.destination.slug}"`)));
  }

  // The whole country as the area: still only this municipality's places.
  const places = await get(portal.host, "/mapa/lugares?area=-70,-23,-57,-9");
  check(() => assert.equal(places.status, 200));
  const keys = JSON.parse(places.body.toString()).places.map((place) => place.key);
  check(() => assert.ok(keys.includes(`destination:${portal.destination.slug}`)));
  check(() => assert.ok(keys.includes(`event:${portal.event.slug}`)));
  for (const other of others) {
    check(() => assert.ok(!keys.includes(`destination:${other.destination.slug}`)));
  }
  if (portal.endedEvent) check(() => assert.ok(!keys.includes(`event:${portal.endedEvent}`)));
  const bad = await get(portal.host, "/mapa/lugares?area=-70,-9,-57,-23");
  check(() => assert.equal(bad.status, 400, "an inverted area is refused"));

  for (const path of ["/", `/destinos/${portal.destination.slug}`]) {
    const bodies = await initialScripts(portal.host, path);
    check(() => assert.ok(bodies.length > 0, `${path} has scripts`));
    check(() =>
      assert.ok(
        !bodies.some((body) => /maplibre/i.test(body)),
        `${path}: MapLibre is not in the initial bundle`,
      ),
    );
  }
}
const maplibre = createRequire(import.meta.url)("maplibre-gl/package.json").version;
const worker = await get(
  "demo-norte.localhost",
  `/vendor/maplibre-gl/${maplibre}/maplibre-gl-worker.mjs`,
);
check(() => assert.equal(worker.status, 200, "the map worker is served from our origin"));
check(() => assert.match(String(worker.headers["cache-control"]), /immutable/));

if (withLogo) {
  // The integration suite published a destination with a cover photo in Demo Norte.
  const list = (await get("demo-norte.localhost", "/destinos")).body.toString();
  const slug = /href="\/destinos\/(integracion-\d+)"/.exec(list)?.[1];
  check(() => assert.ok(slug, "the integration destination is listed"));
  const html = (await get("demo-norte.localhost", `/destinos/${slug}`)).body.toString();
  const cover = /<img[^>]*class="portal-cover"[^>]*>/.exec(html)?.[0] ?? "";
  check(() => assert.match(cover, /fetchPriority="high"|fetchpriority="high"/));
  check(() => assert.match(cover, /width="\d+" height="\d+"/));
  const src = /src="([^"]+)"/.exec(cover)?.[1];
  const image = await fetch(src.replaceAll("&amp;", "&"));
  check(() => assert.equal(image.status, 200, "cover derivative is public"));
  check(() => assert.match(html, /<meta property="og:image" content="[^"]+\/w1600\.webp"/));
}

if (zc01) {
  // Provisioned by the operator in the integration suite: no code, no env change, no deploy.
  const home = await get("zc-ensayo.localhost", "/");
  const html = home.body.toString();
  check(() => assert.equal(home.status, 200, "ZC-01 tenant is live"));
  check(() => assert.match(html, /<title>Ensayo ZC-01<\/title>/));
  // Neutral default brand until its owner publishes one.
  check(() => assert.match(html, /--brand:#24557a/));
}

const unknown = await get("nadie.localhost", "/");
check(() => assert.equal(unknown.status, 404, "unknown host"));
const admin = await get("app.localhost", "/");
check(() => assert.equal(admin.status, 307, "admin without session redirects to login"));

console.log(`portals e2e: ${checks} checks passed`);
