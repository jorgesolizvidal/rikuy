// End-to-end check of the white-label portals on ONE running build (`next start`) backed by
// the real local Supabase stack with the seed: two municipalities, two brands, same code.
// Usage: node e2e/portals.e2e.mjs [port]   (CI job "Integration · real Supabase stack")
import { strict as assert } from "node:assert";
import http from "node:http";

const port = Number(process.argv[2] ?? 3000);

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
  { host: "demo-norte.localhost", name: "Municipio Demo Norte", brand: "#1f6f4a", mode: "light" },
  { host: "demo-sur.localhost", name: "Municipio Demo Sur", brand: "#f0a868", mode: "dark" },
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

const unknown = await get("nadie.localhost", "/");
check(() => assert.equal(unknown.status, 404, "unknown host"));
const admin = await get("app.localhost", "/");
check(() => assert.equal(admin.status, 307, "admin without session redirects to login"));

console.log(`portals e2e: ${checks} checks passed`);
