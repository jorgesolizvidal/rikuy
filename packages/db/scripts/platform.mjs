// Platform maintenance commands (server side, SECRET key). Never shipped to the browser.
//
//   pnpm platform:add-operator <email>          make <email> a platform operator
//   pnpm platform:provision <file.json>         provision a municipality from a JSON file
//
// Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY from apps/web/.env.local (or from
// the environment). The JSON file lives in seed-assets/ (ignored by git), e.g.
//   { "displayName": "…", "slug": "…", "hostname": "….localhost", "ownerEmail": "…" }
// The owner is created as an invited member; they accept after signing in, and the operator
// puts the municipality online from /plataforma — the same path as the panel.
import { readFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
if (!url || !secretKey) {
  console.error("Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SECRET_KEY (apps/web/.env.local).");
  process.exit(1);
}

const admin = createClient(url, secretKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

async function ensureUser(rawEmail) {
  const email = String(rawEmail ?? "")
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`Correo no válido: ${rawEmail}`);
  const found = await admin.rpc("platform_user_id_by_email", { p_email: email });
  if (found.error) throw new Error(`No se pudo buscar la cuenta (${found.error.code})`);
  if (found.data) return { id: found.data, email, created: false };
  const created = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (created.error) throw new Error(`No se pudo crear la cuenta (${created.error.code})`);
  return { id: created.data.user.id, email, created: true };
}

async function addOperator(email) {
  const user = await ensureUser(email);
  const { error } = await admin
    .from("platform_operators")
    .upsert({ user_id: user.id, status: "active", revoked_at: null }, { onConflict: "user_id" });
  if (error) throw new Error(`No se pudo registrar al operador (${error.code})`);
  console.info(
    `Operador listo: ${user.email}${user.created ? " (cuenta nueva)" : ""}. ` +
      "Entra al panel con ese correo y configura la app de autenticación en /plataforma.",
  );
}

async function provision(file) {
  const spec = JSON.parse(readFileSync(file, "utf8"));
  const owner = await ensureUser(spec.ownerEmail);
  const { data, error } = await admin.rpc("provision_tenant", {
    p_slug: spec.slug,
    p_display_name: spec.displayName,
    p_hostname: spec.hostname,
    p_owner_user_id: owner.id,
    p_default_locale: spec.defaultLocale ?? "es",
    p_timezone: spec.timezone ?? "America/La_Paz",
  });
  if (error) {
    const reason = error.hint ? ` (${error.hint})` : "";
    throw new Error(`No se pudo dar de alta: ${error.code}${reason}`);
  }
  console.info(
    `Municipio en preparación: ${spec.displayName} → ${spec.hostname} (id ${data[0].tenant_id}).\n` +
      `Propietario invitado: ${owner.email}. Que entre al panel y acepte; luego ponlo en línea en /plataforma.`,
  );
}

const [command, argument] = process.argv.slice(2);
try {
  if (command === "add-operator" && argument) await addOperator(argument);
  else if (command === "provision" && argument) await provision(argument);
  else {
    console.error("Uso: add-operator <correo> | provision <archivo.json>");
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
