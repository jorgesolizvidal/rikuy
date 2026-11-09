// CI only: deletes every file of the LOCAL stack's buckets, so the restore drill of the CI
// (ADR-046) cannot pass with files left from before. Refuses any address that is not local.
//
//   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SECRET_KEY=… node packages/db/scripts/empty-local-storage.mjs
/* global fetch */
import { BACKUP_BUCKETS } from "./backup-lib.mjs";

const url = process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SECRET_KEY ?? "";
const host = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
})();
if (!["127.0.0.1", "localhost"].includes(host) || !key) {
  console.error("Solo vacía la pila local (SUPABASE_URL en 127.0.0.1 o localhost).");
  process.exit(2);
}

const headers = { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" };

async function names(bucket) {
  const found = [];
  const folders = [""];
  while (folders.length > 0) {
    const prefix = folders.shift();
    const response = await fetch(`${url}/storage/v1/object/list/${bucket}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prefix, limit: 1000, offset: 0 }),
    });
    if (!response.ok) throw new Error(`list ${bucket}: ${response.status}`);
    for (const entry of await response.json()) {
      if (entry.id === null) folders.push(`${prefix}${entry.name}/`);
      else found.push(`${prefix}${entry.name}`);
    }
  }
  return found;
}

let removed = 0;
for (const bucket of BACKUP_BUCKETS) {
  const all = await names(bucket);
  for (let start = 0; start < all.length; start += 100) {
    const prefixes = all.slice(start, start + 100);
    const response = await fetch(`${url}/storage/v1/object/${bucket}`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ prefixes }),
    });
    if (!response.ok) throw new Error(`delete ${bucket}: ${response.status}`);
    removed += prefixes.length;
  }
}
console.info(`Archivos borrados de la pila local: ${removed}`);
