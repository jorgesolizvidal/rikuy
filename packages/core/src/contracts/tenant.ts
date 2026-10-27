import { z } from "zod";

/**
 * Public projection of a tenant resolved from a portal host.
 * Contains only what any visitor of that portal may know.
 */
export const portalTenantSchema = z.object({
  tenantId: z.uuid(),
  slug: z.string().min(1).max(63),
  displayName: z.string().min(1).max(120),
  defaultLocale: z.string().min(2).max(5),
  timezone: z.string().min(1).max(64),
  canonicalHost: z.string().min(1).max(253).nullable(),
  isCanonical: z.boolean(),
  activeConfigId: z.uuid().nullable(),
  /** A commercial demo (ADR-034): never indexed and says so. Absent means a real portal. */
  demo: z.boolean().optional(),
});

export type PortalTenant = z.infer<typeof portalTenantSchema>;

/** Immutable, request-scoped context for a portal request. */
export const tenantContextSchema = z.object({
  version: z.literal(1),
  host: z.string().min(1).max(253),
  tenant: portalTenantSchema,
});

export type TenantContext = z.infer<typeof tenantContextSchema>;

/**
 * Serialization used to hand the context from the proxy to the render layer through an
 * internal request header. The proxy strips any incoming header with the same name, so
 * a client can never supply it. Header values must be ASCII: names with accents are
 * percent-encoded.
 */
export function encodeTenantContext(context: TenantContext): string {
  return encodeURIComponent(JSON.stringify(tenantContextSchema.parse(context)));
}

/** Returns null for anything that is not a well-formed context (never throws). */
export function decodeTenantContext(value: string | null | undefined): TenantContext | null {
  if (!value) return null;
  try {
    const parsed = tenantContextSchema.safeParse(JSON.parse(decodeURIComponent(value)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
