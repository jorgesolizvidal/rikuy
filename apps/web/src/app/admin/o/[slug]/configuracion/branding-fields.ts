import {
  ASSISTANT_TONES,
  isThemeStyle,
  NEARBY_RADIUS,
  PRESENTATION_LIMITS,
  type AssistantTone,
  SOCIAL_NETWORKS,
  type PresentationIssue,
  type SocialNetwork,
  type TenantPresentation,
  themeStyleOf,
  type ThemeStyle,
} from "@rikuy/core";

/**
 * Flat form model of a TenantPresentation. Field names double as FormData keys, so the
 * browser form, the live preview and the Server Action all speak the same shape.
 */
export interface BrandingValues {
  siteName: string;
  shortName: string;
  tagline: string;
  /** The portal's theme (ADR-061): fonts and components. */
  style: ThemeStyle;
  mode: "light" | "dark";
  brand: string;
  accent: string;
  email: string;
  phone: string;
  address: string;
  description: string;
  /** «Estás cerca de…» radius in meters; empty: the default (150 m). */
  nearbyRadius: string;
  /** The visitor assistant's name; empty (and no greeting): the neutral assistant. */
  assistantName: string;
  assistantGreeting: string;
  assistantTone: AssistantTone;
  social: Record<SocialNetwork, string>;
  /** Logo reference (hidden fields `logo.assetId` / `logo.version`); empty: no logo. */
  logoAssetId: string;
  logoVersion: string;
}

export type BrandingField =
  | Exclude<keyof BrandingValues, "social" | "logoAssetId" | "logoVersion">
  | `social.${SocialNetwork}`
  | "logo";

export function valuesFromPresentation(presentation: TenantPresentation): BrandingValues {
  const social = Object.fromEntries(SOCIAL_NETWORKS.map((network) => [network, ""])) as Record<
    SocialNetwork,
    string
  >;
  for (const link of presentation.social) social[link.network] = link.url;
  return {
    siteName: presentation.identity.siteName,
    shortName: presentation.identity.shortName,
    tagline: presentation.identity.tagline,
    style: themeStyleOf(presentation.theme),
    mode: presentation.theme.mode,
    brand: presentation.theme.brand,
    accent: presentation.theme.accent,
    email: presentation.contact.email ?? "",
    phone: presentation.contact.phone ?? "",
    address: presentation.contact.address ?? "",
    description: presentation.seo.description,
    nearbyRadius: presentation.visitors ? String(presentation.visitors.nearbyRadius) : "",
    assistantName: presentation.assistant?.name ?? "",
    assistantGreeting: presentation.assistant?.greeting ?? "",
    assistantTone: presentation.assistant?.tone ?? "warm",
    social,
    logoAssetId: presentation.logo?.assetId ?? "",
    logoVersion: presentation.logo ? String(presentation.logo.version) : "",
  };
}

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Builds the (still unvalidated) presentation input from submitted fields. Empty optional
 * fields are omitted; validation is the use case's job.
 */
export function presentationInputFromForm(formData: FormData) {
  const optional = (name: string) => {
    const value = text(formData, name);
    return value === "" ? {} : { [name]: value };
  };
  return {
    identity: {
      siteName: text(formData, "siteName"),
      shortName: text(formData, "shortName"),
      tagline: text(formData, "tagline"),
    },
    theme: {
      ...styleFromForm(formData),
      mode: text(formData, "mode"),
      brand: text(formData, "brand"),
      accent: text(formData, "accent"),
    },
    contact: { ...optional("email"), ...optional("phone"), ...optional("address") },
    social: SOCIAL_NETWORKS.flatMap((network) => {
      const url = text(formData, `social.${network}`);
      return url === "" ? [] : [{ network, url }];
    }),
    seo: { description: text(formData, "description") },
    ...logoFromForm(formData),
    ...visitorsFromForm(formData),
    ...assistantFromForm(formData),
  };
}

function styleFromForm(formData: FormData) {
  // A form without the field (a page opened before ADR-061) keeps meaning «editorial»; an
  // unknown value fails validation (never a silent default).
  if (!formData.has("style")) return {};
  const style = text(formData, "style");
  return { style: isThemeStyle(style) ? style : "" };
}

function assistantFromForm(formData: FormData) {
  const name = text(formData, "assistantName");
  const greeting = text(formData, "assistantGreeting");
  if (name === "" && greeting === "") return {};
  const tone = text(formData, "assistantTone");
  // A greeting without a name fails validation on the name (never a silent neutral name).
  return {
    assistant: {
      name,
      greeting,
      tone: (ASSISTANT_TONES as readonly string[]).includes(tone) ? tone : "warm",
    },
  };
}

function visitorsFromForm(formData: FormData) {
  const radius = text(formData, "nearbyRadius");
  if (radius === "") return {};
  // Not a whole number → NaN, which validation rejects with a message.
  return { visitors: { nearbyRadius: /^\d{1,5}$/u.test(radius) ? Number(radius) : Number.NaN } };
}

function logoFromForm(formData: FormData) {
  const assetId = text(formData, "logo.assetId");
  const version = text(formData, "logo.version");
  if (assetId === "" && version === "") return {};
  // A non-numeric version becomes NaN and fails validation (never a silent default).
  return { logo: { assetId, version: /^\d+$/u.test(version) ? Number(version) : Number.NaN } };
}

const PATH_TO_FIELD: Readonly<Record<string, BrandingField>> = {
  "identity.siteName": "siteName",
  "identity.shortName": "shortName",
  "identity.tagline": "tagline",
  "theme.style": "style",
  "theme.mode": "mode",
  "theme.brand": "brand",
  "theme.accent": "accent",
  "contact.email": "email",
  "contact.phone": "phone",
  "contact.address": "address",
  "seo.description": "description",
  assistant: "assistantName",
  "assistant.name": "assistantName",
  "assistant.greeting": "assistantGreeting",
  "assistant.tone": "assistantTone",
  visitors: "nearbyRadius",
  "visitors.nearbyRadius": "nearbyRadius",
  logo: "logo",
  "logo.assetId": "logo",
  "logo.version": "logo",
};

const MESSAGES: Readonly<Record<string, string>> = {
  siteName: "Escribe el nombre del portal en una línea, hasta 60 caracteres.",
  shortName: "Escribe un nombre corto de hasta 12 caracteres.",
  tagline: "El lema admite una línea de hasta 140 caracteres.",
  style: "Elige uno de los dos temas.",
  mode: "Elige fondo claro u oscuro. El tema Inmersivo solo tiene fondo oscuro.",
  brand: "Usa un color en formato #rrggbb.",
  accent: "Usa un color en formato #rrggbb.",
  email: "Escribe un correo válido, por ejemplo turismo@municipio.gob.bo.",
  phone: "Usa solo números, espacios, paréntesis o guiones; puede empezar con +.",
  address: "La dirección admite una línea de hasta 160 caracteres.",
  description: "La descripción admite hasta 160 caracteres, en una línea.",
  nearbyRadius: `Escribe un número entero de metros entre ${NEARBY_RADIUS.min} y ${NEARBY_RADIUS.max}, o déjalo vacío para usar ${NEARBY_RADIUS.default} m.`,
  assistantName: `Escribe el nombre del asistente en una línea, hasta ${PRESENTATION_LIMITS.assistantName} caracteres (también si escribiste un saludo).`,
  assistantGreeting: `El saludo admite una línea de hasta ${PRESENTATION_LIMITS.assistantGreeting} caracteres.`,
  assistantTone: "Elige «Cercano» o «Formal».",
  social: "Pega el enlace completo de la página, empezando por https://.",
  logo: "Este logo ya no se puede usar. Sube otro o quítalo para publicar sin logo.",
};

const CONTRAST_MESSAGES: Readonly<Record<string, string>> = {
  "contrast.brandOnBackground":
    "El color principal no se lee bien sobre el fondo: necesita un contraste de al menos 4.5:1. Prueba un tono más oscuro con fondo claro, o más claro con fondo oscuro.",
  "contrast.textOnBrand":
    "El texto de los botones no se lee bien sobre el color principal: necesita al menos 4.5:1.",
  "contrast.accentOnBackground":
    "El color de acento casi no se distingue del fondo: necesita al menos 3:1.",
};

/** Maps use-case issues to messages keyed by form field. */
export function fieldErrors(
  issues: readonly PresentationIssue[],
  submittedSocial: readonly { network: SocialNetwork }[],
): Partial<Record<BrandingField, string>> {
  const errors: Partial<Record<BrandingField, string>> = {};
  for (const issue of issues) {
    let field: BrandingField | undefined = PATH_TO_FIELD[issue.path];
    const social = /^social\.(\d+)/.exec(issue.path);
    if (social) {
      const network = submittedSocial[Number(social[1])]?.network;
      if (network) field = `social.${network}`;
    }
    if (field === undefined) continue;
    errors[field] ??=
      CONTRAST_MESSAGES[issue.code] ??
      MESSAGES[field.startsWith("social.") ? "social" : field] ??
      "Revisa este campo.";
  }
  return errors;
}
