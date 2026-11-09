// Backup and restore of the files and the checks of a restore (ADR-046). Server side only:
// it uses the SECRET key of the project it talks to and never prints data, only counts.
//
//   node packages/db/scripts/backup.mjs download <dir>          files of every bucket → <dir>/storage
//   node packages/db/scripts/backup.mjs manifest <dir>          <dir>/manifest.json from the dump and the files
//   node packages/db/scripts/backup.mjs restore-sql <dir>       the SQL that loads the data (backup-restore-db.sh)
//   node packages/db/scripts/backup.mjs restore-storage <dir>   uploads the files back (upsert)
//   node packages/db/scripts/backup.mjs verify <dir>            row counts, every file, the portal's reads
//
// Environment: SUPABASE_URL and SUPABASE_SECRET_KEY (every command that talks to Storage);
// verify also needs SUPABASE_PUBLISHABLE_KEY and SUPABASE_DB_URL (psql). The database itself
// is dumped and loaded by the Supabase CLI and psql (see docs/backup.md).
/* global fetch */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  BACKUP_BUCKETS,
  BACKUP_FORMAT,
  countCopyRows,
  encodeObjectName,
  formatBytes,
  objectPath,
  parseManifest,
  quoteTable,
  restoreScript,
  rowMismatches,
  summarize,
} from "./backup-lib.mjs";

const CONCURRENCY = 8;

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable ${name}`);
  return value;
}

function storageHeaders() {
  const key = env("SUPABASE_SECRET_KEY");
  return { apikey: key, authorization: `Bearer ${key}` };
}

function storageUrl(path) {
  return `${env("SUPABASE_URL").replace(/\/$/u, "")}/storage/v1/${path}`;
}

/** Writes Markdown to the job's summary (GitHub Actions) and the console. */
function report(lines) {
  const text = `${lines.join("\n")}\n`;
  console.info(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}

/** Runs `items` through `work`, `CONCURRENCY` at a time. */
async function pool(items, work) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, runner));
  return results;
}

async function request(url, init, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.status < 500 || attempt === attempts) return response;
    } catch (cause) {
      if (attempt === attempts) throw cause;
    }
    await sleep(attempt * 1_000);
  }
}

/** Every object of a bucket, folders walked one by one (the list API is per folder). */
async function listBucket(bucket) {
  const objects = [];
  const folders = [""];
  while (folders.length > 0) {
    const prefix = folders.shift();
    for (let offset = 0; ; offset += 1000) {
      const response = await request(storageUrl(`object/list/${bucket}`), {
        method: "POST",
        headers: { ...storageHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: "name" } }),
      });
      if (!response.ok) throw new Error(`No se pudo listar ${bucket} (${response.status})`);
      const entries = await response.json();
      for (const entry of entries) {
        const name = `${prefix}${entry.name}`;
        if (entry.id === null) folders.push(`${name}/`);
        else objects.push({ name, metadata: entry.metadata ?? {} });
      }
      if (entries.length < 1000) break;
    }
  }
  return objects;
}

async function download(dir) {
  const files = [];
  for (const bucket of BACKUP_BUCKETS) {
    const objects = await listBucket(bucket);
    const saved = await pool(objects, async (object) => {
      const path = objectPath(bucket, object.name);
      const response = await request(
        storageUrl(`object/authenticated/${bucket}/${encodeObjectName(object.name)}`),
        { headers: storageHeaders() },
      );
      if (!response.ok) throw new Error(`No se pudo descargar un archivo (${response.status})`);
      const bytes = Buffer.from(await response.arrayBuffer());
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), bytes, { mode: 0o600 });
      return {
        bucket,
        name: object.name,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        mimetype: object.metadata.mimetype ?? null,
        cacheControl: object.metadata.cacheControl ?? null,
      };
    });
    files.push(...saved);
  }
  writeFileSync(join(dir, "storage.json"), JSON.stringify(files), { mode: 0o600 });
  console.info(`Archivos descargados: ${files.length}`);
}

function manifest(dir) {
  const tables = countCopyRows(readFileSync(join(dir, "db", "data.sql"), "utf8"));
  const files = JSON.parse(readFileSync(join(dir, "storage.json"), "utf8"));
  const value = parseManifest({
    format: BACKUP_FORMAT,
    createdAt: new Date().toISOString(),
    source: process.env.BACKUP_SOURCE ?? "local",
    commit: process.env.GITHUB_SHA ?? null,
    tables,
    files,
  });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(value, null, 1), { mode: 0o600 });
  const summary = summarize(value);
  const objectRows = value.tables["storage.objects"] ?? 0;
  report([
    "### Respaldo",
    "",
    `| Qué | Cantidad |`,
    `| --- | --- |`,
    `| Tablas | ${summary.tables} |`,
    `| Filas | ${summary.rows} |`,
    ...BACKUP_BUCKETS.map(
      (bucket) =>
        `| Archivos de \`${bucket}\` | ${summary.byBucket[bucket].files} (${formatBytes(summary.byBucket[bucket].bytes)}) |`,
    ),
    "",
    objectRows === summary.files
      ? "Cada archivo de la base tiene su copia."
      : `⚠️ La base registra ${objectRows} archivos y se copiaron ${summary.files}.`,
  ]);
}

function readManifest(dir) {
  return parseManifest(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
}

/** The SQL that loads the backup into a migrated database (see backup-restore-db.sh). */
function restoreSql(dir) {
  readManifest(dir);
  process.stdout.write(restoreScript(readFileSync(join(dir, "db", "data.sql"), "utf8")));
}

async function restoreStorage(dir) {
  const value = readManifest(dir);
  const started = Date.now();
  await pool(value.files, async (file) => {
    const bytes = readFileSync(join(dir, objectPath(file.bucket, file.name)));
    const headers = { ...storageHeaders(), "x-upsert": "true" };
    if (file.mimetype) headers["content-type"] = file.mimetype;
    if (file.cacheControl) headers["cache-control"] = file.cacheControl;
    const response = await request(
      storageUrl(`object/${file.bucket}/${encodeObjectName(file.name)}`),
      { method: "POST", headers, body: bytes },
    );
    if (!response.ok) {
      throw new Error(`No se pudo subir un archivo de ${file.bucket} (${response.status})`);
    }
  });
  console.info(`Archivos restaurados: ${value.files.length} en ${Date.now() - started} ms`);
}

/** One JSON value from psql (the query must return a single json column). */
function psqlJson(sql) {
  const result = spawnSync("psql", [env("SUPABASE_DB_URL"), "-XAtq", "-v", "ON_ERROR_STOP=1"], {
    input: sql,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`psql falló: ${result.stderr.split("\n")[0]}`);
  return JSON.parse(result.stdout.trim() || "null");
}

async function verify(dir) {
  const value = readManifest(dir);
  const problems = [];

  // 1. Every table has the rows it had. A table this role cannot read (the platform's own)
  //    only counts when the backup had rows in it.
  const literal = Object.keys(value.tables)
    .map((table) => `'${quoteTable(table).replaceAll("'", "''")}'`)
    .join(", ");
  const readable = new Set(
    psqlJson(`select coalesce(json_agg(t), '[]') from unnest(array[${literal}]::text[]) as t
      where has_table_privilege(t, 'select');`) ?? [],
  );
  const counted = Object.keys(value.tables).filter((table) => readable.has(quoteTable(table)));
  const counts =
    (counted.length === 0
      ? {}
      : psqlJson(
          `select json_object_agg(t, c) from (${counted
            .map(
              (table) =>
                `select '${table.replaceAll("'", "''")}' as t, count(*)::int as c from ${quoteTable(table)}`,
            )
            .join(" union all ")}) as counts;`,
        )) ?? {};
  for (const table of Object.keys(value.tables)) {
    if (!readable.has(quoteTable(table)) && value.tables[table] === 0) counts[table] = 0;
  }
  const mismatches = rowMismatches(value.tables, counts);
  for (const mismatch of mismatches) {
    problems.push(
      `${mismatch.table}: ${mismatch.expected} filas en el respaldo, ${mismatch.actual ?? "sin tabla"} restauradas`,
    );
  }

  // 2. Every file comes back byte for byte, and the base knows each one.
  const missing = [];
  await pool(value.files, async (file) => {
    const response = await request(
      storageUrl(`object/authenticated/${file.bucket}/${encodeObjectName(file.name)}`),
      { headers: storageHeaders() },
    );
    if (!response.ok) return missing.push(file);
    const digest = createHash("sha256")
      .update(Buffer.from(await response.arrayBuffer()))
      .digest("hex");
    if (digest !== file.sha256) missing.push(file);
  });
  if (missing.length > 0) problems.push(`${missing.length} archivos no volvieron iguales`);
  const objectRows = counts["storage.objects"] ?? 0;
  if (objectRows !== value.files.length) {
    problems.push(
      `La base registra ${objectRows} archivos y el respaldo trae ${value.files.length}`,
    );
  }

  // 3. A visitor's reads work: public files, and each online municipality from its address.
  const publicFile = value.files.find((file) => file.bucket === "media-public");
  if (publicFile) {
    const response = await request(
      storageUrl(`object/public/media-public/${encodeObjectName(publicFile.name)}`),
      {},
    );
    if (!response.ok) problems.push(`Un archivo público no responde (${response.status})`);
  }
  const portals =
    psqlJson(`select coalesce(json_agg(json_build_object('host', d.hostname, 'tenant', t.id,
        'destinations', (select count(*) from public.content_items c
          where c.tenant_id = t.id and c.kind = 'destination' and c.published_revision_id is not null))), '[]')
      from public.tenants t join public.tenant_domains d on d.tenant_id = t.id
      where t.status = 'active' and d.status = 'active';`) ?? [];
  const publishable = env("SUPABASE_PUBLISHABLE_KEY");
  const rest = (fn, body) =>
    request(`${env("SUPABASE_URL").replace(/\/$/u, "")}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: publishable, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  let portalsOk = 0;
  for (const portal of portals) {
    const resolved = await rest("resolve_tenant_by_host", { p_host: portal.host });
    const rows = resolved.ok ? await resolved.json() : [];
    const found = Array.isArray(rows) && rows.some((row) => row.tenant_id === portal.tenant);
    const listed = await rest("portal_destinations", { p_tenant_id: portal.tenant });
    const destinations = listed.ok ? await listed.json() : null;
    if (found && Array.isArray(destinations) && destinations.length === portal.destinations) {
      portalsOk += 1;
    }
  }
  if (portalsOk !== portals.length) {
    problems.push(`${portals.length - portalsOk} de ${portals.length} portales no responden igual`);
  }

  // 4. The accounts are readable by Auth, not only present in the table.
  const users = await request(
    `${env("SUPABASE_URL").replace(/\/$/u, "")}/auth/v1/admin/users?page=1&per_page=1`,
    { headers: storageHeaders() },
  );
  const total = Number(users.headers.get("x-total-count") ?? Number.NaN);
  if (!users.ok || total !== (counts["auth.users"] ?? 0)) {
    problems.push(`Auth no ve las ${counts["auth.users"] ?? 0} cuentas restauradas`);
  }

  const summary = summarize(value);
  report([
    "### Restauración",
    "",
    `Respaldo del ${value.createdAt} (formato ${value.format}).`,
    "",
    "| Comprobación | Resultado |",
    "| --- | --- |",
    `| Filas de ${summary.tables} tablas | ${mismatches.length === 0 ? `✓ ${summary.rows}` : `✗ ${mismatches.length} tablas distintas`} |`,
    `| Archivos, byte por byte | ${missing.length === 0 ? `✓ ${summary.files} (${formatBytes(summary.bytes)})` : `✗ ${missing.length} distintos`} |`,
    `| Portales en línea (dirección y destinos) | ${portalsOk === portals.length ? "✓" : "✗"} ${portalsOk} de ${portals.length} |`,
    `| Cuentas legibles por Auth | ${Number.isFinite(total) && total === (counts["auth.users"] ?? 0) ? "✓" : "✗"} ${Number.isFinite(total) ? total : "?"} |`,
  ]);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error title=restore::${problem}`);
    process.exit(1);
  }
}

const [command, dir] = process.argv.slice(2);
const commands = {
  download,
  manifest,
  "restore-sql": restoreSql,
  "restore-storage": restoreStorage,
  verify,
};
if (!commands[command] || !dir) {
  console.error("Uso: backup.mjs <download|manifest|restore-sql|restore-storage|verify> <carpeta>");
  process.exit(2);
}
try {
  await commands[command](dir);
} catch (error) {
  console.error(`::error title=backup::${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
