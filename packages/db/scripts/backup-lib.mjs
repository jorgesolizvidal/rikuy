// Pure helpers of the backup and the restore drill (ADR-046): no network, no secrets.
// They are tested in backup-lib.test.mjs; backup.mjs does the I/O.

/** The buckets whose files the backup carries (originals cannot be regenerated). */
export const BACKUP_BUCKETS = ["media-originals", "media-public"];

/** The manifest's format; a restore refuses a format it does not know. */
export const BACKUP_FORMAT = 1;

/**
 * Tables the data dump leaves out: the platform's schedule and its HTTP log are rebuilt by the
 * migrations (and the schedule must not run against a restored copy before it is configured).
 */
export const DUMP_EXCLUDED_TABLES = [
  "cron.job",
  "cron.job_run_details",
  "net._http_response",
  "net.http_request_queue",
];

const COPY_LINE = /^COPY "((?:[^"]|"")+)"\."((?:[^"]|"")+)" \(.*\) FROM stdin;$/u;

/**
 * Rows per table in a `supabase db dump --data-only --use-copy` file. Every dumped table has a
 * COPY block, even an empty one, so the keys are also the tables a restore replaces.
 *
 * @param {string} sql
 * @returns {Record<string, number>}
 */
export function countCopyRows(sql) {
  /** @type {Record<string, number>} */
  const counts = {};
  /** @type {string | null} */
  let current = null;
  for (const raw of sql.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (current === null) {
      const match = COPY_LINE.exec(line);
      if (match) {
        current = `${match[1].replaceAll('""', '"')}.${match[2].replaceAll('""', '"')}`;
        if (current in counts) throw new Error(`Tabla repetida en el volcado: ${current}`);
        counts[current] = 0;
      }
      continue;
    }
    if (line === "\\.") {
      current = null;
      continue;
    }
    counts[current] += 1;
  }
  if (current !== null) throw new Error(`El volcado termina dentro de la tabla ${current}`);
  return counts;
}

/**
 * The data dump without its empty COPY blocks: loading nothing into a table still needs the
 * right to write it, and some platform tables (Storage's own) are not writable by `postgres`.
 *
 * @param {string} sql
 */
export function withoutEmptyCopies(sql) {
  const lines = sql.split("\n");
  const kept = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
    const next = lines[index + 1] ?? "";
    if (COPY_LINE.test(bare) && (next === "\\." || next === "\\.\r")) {
      index += 1;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/**
 * The SQL that replaces the database's rows with a backup's: with triggers and foreign-key
 * checks off, empties every dumped table that has rows now (a table the role cannot read is
 * left alone: the platform's own), then loads the non-empty COPY blocks.
 *
 * @param {string} sql the data dump
 */
export function restoreScript(sql) {
  const tables = Object.keys(countCopyRows(sql)).map(quoteTable);
  const literal = tables.map((table) => `'${table.replaceAll("'", "''")}'`).join(", ");
  return [
    "set session_replication_role = replica;",
    "do $restore$",
    "declare t text;",
    "declare has_rows boolean;",
    "begin",
    `  foreach t in array array[${literal}]::text[] loop`,
    "    continue when not has_table_privilege(t, 'select');",
    "    execute format('select exists (select 1 from %s)', t) into has_rows;",
    "    if has_rows then execute format('truncate %s cascade', t); end if;",
    "  end loop;",
    "end",
    "$restore$;",
    withoutEmptyCopies(sql),
  ].join("\n");
}

/** `"schema"."table"`, quoted for SQL. */
export function quoteTable(table) {
  const dot = table.indexOf(".");
  if (dot <= 0 || dot === table.length - 1) throw new Error(`Tabla sin esquema: ${table}`);
  const quote = (part) => `"${part.replaceAll('"', '""')}"`;
  return `${quote(table.slice(0, dot))}.${quote(table.slice(dot + 1))}`;
}

/**
 * The local path of an object, refusing names that would leave the backup's folder.
 *
 * @param {string} bucket
 * @param {string} name
 */
export function objectPath(bucket, name) {
  if (!BACKUP_BUCKETS.includes(bucket)) throw new Error(`Bucket desconocido: ${bucket}`);
  const parts = name.split("/");
  if (
    name.length === 0 ||
    name.includes("\\") ||
    name.includes("\0") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Nombre de archivo no permitido: ${JSON.stringify(name)}`);
  }
  return ["storage", bucket, ...parts].join("/");
}

/** One segment-wise encoded object path for the Storage API. */
export function encodeObjectName(name) {
  return name.split("/").map(encodeURIComponent).join("/");
}

/**
 * @typedef {{ bucket: string, name: string, size: number, sha256: string,
 *   mimetype: string | null, cacheControl: string | null }} BackupFile
 * @typedef {{ format: number, createdAt: string, source: string, commit: string | null,
 *   tables: Record<string, number>, files: BackupFile[] }} BackupManifest
 */

/**
 * Checks a manifest read back from an archive before anything is restored from it.
 *
 * @param {unknown} value
 * @returns {BackupManifest}
 */
export function parseManifest(value) {
  if (typeof value !== "object" || value === null) throw new Error("Manifiesto vacío");
  const manifest = /** @type {Record<string, unknown>} */ (value);
  if (manifest.format !== BACKUP_FORMAT) {
    throw new Error(`Formato de respaldo desconocido: ${String(manifest.format)}`);
  }
  if (typeof manifest.createdAt !== "string" || Number.isNaN(Date.parse(manifest.createdAt))) {
    throw new Error("El manifiesto no tiene su fecha");
  }
  const tables = manifest.tables;
  if (typeof tables !== "object" || tables === null || Array.isArray(tables)) {
    throw new Error("El manifiesto no tiene las tablas");
  }
  for (const [table, rows] of Object.entries(tables)) {
    quoteTable(table);
    if (!Number.isInteger(rows) || rows < 0) throw new Error(`Filas no válidas en ${table}`);
  }
  if (!Array.isArray(manifest.files)) throw new Error("El manifiesto no tiene los archivos");
  const seen = new Set();
  for (const file of manifest.files) {
    objectPath(file?.bucket, file?.name);
    if (!Number.isInteger(file.size) || file.size < 0) throw new Error("Tamaño no válido");
    if (!/^[0-9a-f]{64}$/u.test(file.sha256)) throw new Error("Huella no válida");
    const key = `${file.bucket}/${file.name}`;
    if (seen.has(key)) throw new Error(`Archivo repetido: ${key}`);
    seen.add(key);
  }
  return /** @type {BackupManifest} */ (manifest);
}

/** What the summary shows: counts only, never names, addresses or content. */
export function summarize(manifest) {
  const rows = Object.values(manifest.tables).reduce((total, count) => total + count, 0);
  const byBucket = Object.fromEntries(
    BACKUP_BUCKETS.map((bucket) => {
      const files = manifest.files.filter((file) => file.bucket === bucket);
      return [bucket, { files: files.length, bytes: files.reduce((t, f) => t + f.size, 0) }];
    }),
  );
  return {
    tables: Object.keys(manifest.tables).length,
    rows,
    files: manifest.files.length,
    bytes: manifest.files.reduce((total, file) => total + file.size, 0),
    byBucket,
  };
}

/**
 * Tables whose restored row count differs from the backup's.
 *
 * @param {Record<string, number>} expected
 * @param {Record<string, number>} actual
 */
export function rowMismatches(expected, actual) {
  return Object.entries(expected)
    .filter(([table, rows]) => actual[table] !== rows)
    .map(([table, rows]) => ({ table, expected: rows, actual: actual[table] ?? null }));
}

/** «1,2 MB»: bytes for people. */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1).replace(".", ",")} ${units[unit]}`;
}
