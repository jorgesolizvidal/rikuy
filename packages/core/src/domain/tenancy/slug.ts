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
export function slugify(name: string, maxLength: number): string {
  return name
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}

/** Tenant slug (also a DNS label: at most 63 characters). */
export function suggestSlug(name: string): string {
  return slugify(name, 63);
}
