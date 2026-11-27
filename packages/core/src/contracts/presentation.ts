import { z } from "zod";

import { HEX_COLOR_PATTERN } from "../domain/branding/color";
import {
  DEFAULT_HOME,
  HERO_VARIANTS,
  HOME_LIMITS,
  HOME_SECTION_KEYS,
  isHomeVariant,
  type HomeLayout,
} from "../domain/branding/home";
import { NEARBY_RADIUS } from "../domain/geo/proximity";
import {
  styleAllowsMode,
  THEME_STYLES,
  themeContrast,
  themeStyleOf,
  type ContrastCheck,
} from "../domain/branding/theme";
import { openingHoursSchema } from "./destination";
import { WHATSAPP_PATTERN } from "./service";

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
  assistantName: 40,
  assistantGreeting: 240,
  helpDeskName: 60,
} as const;

/** How the assistant speaks (ADR-038): fixed options, never free text sent to the model. */
export const ASSISTANT_TONES = ["warm", "formal"] as const;
export type AssistantTone = (typeof ASSISTANT_TONES)[number];

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The portal's home (ADR-062): fixed keys and variants; text in single lines. */
export const homeLayoutSchema = z.strictObject({
  hero: z.strictObject({
    variant: z.enum(HERO_VARIANTS),
    /** Photo of this destination; null: the first destination that has a photo. */
    destinationId: z.string().regex(UUID).nullable(),
  }),
  figures: z
    .array(
      z.strictObject({
        value: line(1, HOME_LIMITS.figureValue),
        label: line(1, HOME_LIMITS.figureLabel),
      }),
    )
    .max(HOME_LIMITS.figures),
  sections: z
    .array(
      z
        .strictObject({ key: z.enum(HOME_SECTION_KEYS), variant: z.string() })
        .refine((section) => isHomeVariant(section.key, section.variant), {
          path: ["variant"],
          message: "unknown_variant",
        }),
    )
    .max(HOME_LIMITS.sections)
    .refine(
      (sections) => new Set(sections.map((section) => section.key)).size === sections.length,
      {
        message: "duplicate_section",
      },
    ),
});

export const tenantPresentationSchema = z.strictObject({
  identity: z.strictObject({
    siteName: line(1, PRESENTATION_LIMITS.siteName),
    shortName: line(1, PRESENTATION_LIMITS.shortName),
    tagline: line(0, PRESENTATION_LIMITS.tagline),
  }),
  /**
   * The style (ADR-061) brings fonts and components; absent means «editorial». The
   * «immersive» style exists only on a dark background.
   */
  theme: z
    .strictObject({
      style: z.enum(THEME_STYLES).optional(),
      mode: z.enum(["light", "dark"]),
      brand: hexColorSchema,
      accent: hexColorSchema,
    })
    .refine((theme) => styleAllowsMode(themeStyleOf(theme), theme.mode), {
      path: ["mode"],
      message: "mode_not_allowed",
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
  /** Optional logo: a reference to a ready image of the same tenant, never a URL. */
  logo: z
    .strictObject({
      assetId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      version: z.number().int().min(1).max(999_999),
    })
    .optional(),
  /**
   * Optional coat of arms of the municipality, shown in the portal's footer: a reference to
   * a ready logo-type image of the same tenant, like the logo (ADR-068).
   */
  crest: z
    .strictObject({
      assetId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      version: z.number().int().min(1).max(999_999),
    })
    .optional(),
  /** Optional visitor settings; absent means the defaults. */
  visitors: z
    .strictObject({
      /** «Estás cerca de…» radius around a destination, in meters (ADR-021). */
      nearbyRadius: z.number().int().min(NEARBY_RADIUS.min).max(NEARBY_RADIUS.max),
    })
    .optional(),
  /** Optional persona of the visitor's assistant (ADR-022, ADR-038); absent: a neutral one. */
  assistant: z
    .strictObject({
      name: line(1, PRESENTATION_LIMITS.assistantName),
      greeting: line(0, PRESENTATION_LIMITS.assistantGreeting),
      tone: z.enum(ASSISTANT_TONES),
    })
    .optional(),
  /** Optional home of the portal (ADR-062); absent: the platform's default. */
  home: homeLayoutSchema.optional(),
  /**
   * Optional «Atención al visitante» (ADR-073): who answers a visitor who asks for a person.
   * Its WhatsApp is international; the phone and the email stay the portal's (`contact`).
   */
  helpDesk: z
    .strictObject({
      name: line(1, PRESENTATION_LIMITS.helpDeskName),
      whatsapp: z.string().trim().regex(WHATSAPP_PATTERN).optional(),
      hours: openingHoursSchema.optional(),
    })
    .optional(),
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

/** The municipality's «Estás cerca de…» radius in meters (default 150 m). */
export function nearbyRadiusOf(presentation: TenantPresentation): number {
  return presentation.visitors?.nearbyRadius ?? NEARBY_RADIUS.default;
}

/** The municipality's home, or the platform's default. */
export function homeOf(presentation: TenantPresentation): HomeLayout {
  return presentation.home ?? DEFAULT_HOME;
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
    theme: { style: "editorial", mode: "light", brand: "#24557a", accent: "#8a6d1f" },
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
