/**
 * Tenant slugs: lowercase ASCII labels, also used for platform subdomains. Mirrors the
 * database constraints (tenants_slug_format / tenants_slug_not_reserved).
 */

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "app",
  "api",
  "www",
  "admin",
  "assets",
  "cdn",
  "status",
  "staging",
  "preview",
  "mail",
  "auth",
]);

export function isValidSlug(value: string): boolean {
  return SLUG_PATTERN.test(value) && !RESERVED_SLUGS.has(value);
}

/** "Villa Peña (Norte)" → "villa-pena-norte". Accents are folded, never dropped words. */
export function suggestSlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}
