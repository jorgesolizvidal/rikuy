import { z } from "zod";

import { HEX_COLOR_PATTERN } from "../domain/branding/color";
import { themeContrast, type ContrastCheck } from "../domain/branding/theme";

/**
 * White-label presentation of a tenant portal (stored in `tenant_config_versions.branding`).
 *
 * Plain data only: no HTML, CSS or scripts. Every string is single-line text, colors are
 * `#rrggbb` and links are https. The database re-checks the same shape
 * (`private.is_valid_presentation`) so the RPC cannot be used to bypass this contract.
 */

export const PRESENTATION_SCHEMA_VERSION = 1;

export const SOCIAL_NETWORKS = ["facebook", "instagram", "tiktok", "youtube", "x"] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

export const PRESENTATION_LIMITS = {
  siteName: 60,
  shortName: 12,
  tagline: 140,
  address: 160,
  phone: 30,
  email: 254,
  url: 300,
  description: 160,
} as const;

// No control characters (newlines, tabs, NUL…): every field renders as one line of text.
const NO_CONTROL_CHARACTERS = /^[^\p{Cc}]*$/u;

const line = (min: number, max: number) =>
  z.string().trim().min(min).max(max).regex(NO_CONTROL_CHARACTERS);

export const hexColorSchema = z.string().trim().toLowerCase().regex(HEX_COLOR_PATTERN);

const httpsUrlSchema = z
  .string()
  .trim()
  .max(PRESENTATION_LIMITS.url)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.username === "" && url.password === "";
    } catch {
      return false;
    }
  });

export const tenantPresentationSchema = z.strictObject({
  identity: z.strictObject({
    siteName: line(1, PRESENTATION_LIMITS.siteName),
    shortName: line(1, PRESENTATION_LIMITS.shortName),
    tagline: line(0, PRESENTATION_LIMITS.tagline),
  }),
  theme: z.strictObject({
    mode: z.enum(["light", "dark"]),
    brand: hexColorSchema,
    accent: hexColorSchema,
  }),
  contact: z.strictObject({
    email: z.email().max(PRESENTATION_LIMITS.email).optional(),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9][0-9 ()-]{5,29}$/)
      .optional(),
    address: line(1, PRESENTATION_LIMITS.address).optional(),
  }),
  social: z
    .array(z.strictObject({ network: z.enum(SOCIAL_NETWORKS), url: httpsUrlSchema }))
    .max(SOCIAL_NETWORKS.length)
    .refine((links) => new Set(links.map((link) => link.network)).size === links.length, {
      message: "duplicate_network",
    }),
  seo: z.strictObject({
    description: line(0, PRESENTATION_LIMITS.description),
  }),
});

export type TenantPresentation = z.infer<typeof tenantPresentationSchema>;
export type TenantPresentationInput = z.input<typeof tenantPresentationSchema>;

export type PresentationIssueCode = "invalid" | `contrast.${ContrastCheck}`;

export interface PresentationIssue {
  /** Dot path of the offending field, e.g. `identity.shortName` or `social.1.url`. */
  readonly path: string;
  readonly code: PresentationIssueCode;
}

export type PresentationValidation =
  | { readonly ok: true; readonly value: TenantPresentation }
  | { readonly ok: false; readonly issues: readonly PresentationIssue[] };

const CONTRAST_FIELD: Readonly<Record<ContrastCheck, string>> = {
  brandOnBackground: "theme.brand",
  textOnBrand: "theme.brand",
  accentOnBackground: "theme.accent",
};

/** Full validation for writes: shape first, then WCAG AA contrast of the theme. */
export function validatePresentation(input: unknown): PresentationValidation {
  const parsed = tenantPresentationSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        code: "invalid" as const,
      })),
    };
  }
  const issues = themeContrast(parsed.data.theme)
    .filter((result) => !result.passes)
    .map((result) => ({
      path: CONTRAST_FIELD[result.check],
      code: `contrast.${result.check}` as const,
    }));
  return issues.length === 0 ? { ok: true, value: parsed.data } : { ok: false, issues };
}

/** Shape-only parsing for reads (stored versions were already validated on write). */
export function parseStoredPresentation(value: unknown): TenantPresentation | null {
  const parsed = tenantPresentationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Up to 12 characters taken from the end of the name ("Municipio Demo Norte" → "Demo Norte"). */
export function deriveShortName(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  let short = "";
  for (let i = words.length - 1; i >= 0; i -= 1) {
    const candidate = short === "" ? (words[i] ?? "") : `${words[i] ?? ""} ${short}`;
    if (Array.from(candidate).length > PRESENTATION_LIMITS.shortName) break;
    short = candidate;
  }
  return short !== ""
    ? short
    : Array.from(name.trim()).slice(0, PRESENTATION_LIMITS.shortName).join("");
}

/** Neutral presentation used until a tenant publishes its own. Contains no tenant literals. */
export function defaultPresentation(tenant: { readonly displayName: string }): TenantPresentation {
  return {
    identity: {
      siteName: tenant.displayName,
      shortName: deriveShortName(tenant.displayName),
      tagline: "",
    },
    theme: { mode: "light", brand: "#24557a", accent: "#8a6d1f" },
    contact: {},
    social: [],
    seo: { description: "" },
  };
}

/** Two-letter monogram for generated icons ("Demo Norte" → "DN", "Rikuy" → "R"). */
export function monogram(shortName: string): string {
  const letters = shortName
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "");
  return letters.join("").toLocaleUpperCase("es") || "?";
}
