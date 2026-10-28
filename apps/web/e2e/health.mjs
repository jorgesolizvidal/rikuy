// Daily health check of production (Hito · Paso 3, ADR-035), run by GitHub Actions.
//
// For every portal in LIGHTHOUSE_ORIGINS ("slug=https://…,slug=https://…"):
//   - the home page answers 200 and says which version it serves (X-Rikuy-Version);
//   - /mapa answers 200. It is rendered per request, so it reads the database through the
//     Data API: that is the activity that keeps a free Supabase project from being paused.
// And ADMIN_ORIGIN (optional): the panel's sign-in page answers 200.
//
// Any failure fails the job, and GitHub emails whoever owns the schedule. Nothing is sent
// anywhere else; no secret is needed.
const origins = (process.env.LIGHTHOUSE_ORIGINS ?? "")
  .split(",")
  .map((pair) => pair.trim().split("="))
  .filter(([slug, origin]) => slug && origin)
  .map(([slug, origin]) => [slug, origin.replace(/\/$/u, "")]);
if (origins.length === 0) {
  console.log("::error title=Health::LIGHTHOUSE_ORIGINS is not configured");
  process.exit(1);
}

const checks = [];
for (const [slug, origin] of origins) {
  checks.push({ name: `${slug} · inicio`, url: `${origin}/`, version: true });
  checks.push({
    name: `${slug} · mapa (base de datos)`,
    url: `${origin}/mapa?salud=${Date.now()}`,
  });
}
const admin = (process.env.ADMIN_ORIGIN ?? "").replace(/\/$/u, "");
if (admin) checks.push({ name: "panel · inicio de sesión", url: `${admin}/login` });

async function run(check) {
  // A cold function can take a few seconds: one retry before calling it down.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const started = Date.now();
    try {
      const response = await fetch(check.url, {
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
        headers: { "user-agent": "rikuy-health-check" },
      });
      const version = response.headers.get("x-rikuy-version");
      const ok = response.status === 200 && (!check.version || Boolean(version));
      if (ok || attempt === 2) {
        return { ...check, ok, status: response.status, version, ms: Date.now() - started };
      }
    } catch (error) {
      if (attempt === 2) {
        return {
          ...check,
          ok: false,
          status: error?.name ?? "error",
          version: null,
          ms: Date.now() - started,
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

const results = [];
for (const check of checks) results.push(await run(check));

const rows = results.map(
  (r) => `| ${r.ok ? "✅" : "❌"} | ${r.name} | ${r.status} | ${r.ms} ms | ${r.version ?? ""} |`,
);
const table = [
  "| | Comprobación | Respuesta | Tiempo | Versión |",
  "| - | - | - | - | - |",
  ...rows,
].join("\n");
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Salud de producción\n\n${table}\n`);
}
const failed = results.filter((r) => !r.ok);
for (const r of failed) {
  console.log(`::error title=Health::${r.name} answered ${r.status} (${r.url.split("?")[0]})`);
}
process.exit(failed.length > 0 ? 1 : 0);
