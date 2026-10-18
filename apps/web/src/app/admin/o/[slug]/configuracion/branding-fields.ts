import {
  NEARBY_RADIUS,
  SOCIAL_NETWORKS,
  type PresentationIssue,
  type SocialNetwork,
  type TenantPresentation,
} from "@rikuy/core";

/**
 * Flat form model of a TenantPresentation. Field names double as FormData keys, so the
 * browser form, the live preview and the Server Action all speak the same shape.
 */
export interface BrandingValues {
  siteName: string;
  shortName: string;
  tagline: string;
  mode: "light" | "dark";
  brand: string;
  accent: string;
  email: string;
  phone: string;
  address: string;
  description: string;
  /** «Estás cerca de…» radius in meters; empty: the default (150 m). */
  nearbyRadius: string;
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
    mode: presentation.theme.mode,
    brand: presentation.theme.brand,
    accent: presentation.theme.accent,
    email: presentation.contact.email ?? "",
    phone: presentation.contact.phone ?? "",
    address: presentation.contact.address ?? "",
    description: presentation.seo.description,
    nearbyRadius: presentation.visitors ? String(presentation.visitors.nearbyRadius) : "",
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
  "theme.mode": "mode",
  "theme.brand": "brand",
  "theme.accent": "accent",
  "contact.email": "email",
  "contact.phone": "phone",
  "contact.address": "address",
  "seo.description": "description",
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
  mode: "Elige fondo claro u oscuro.",
  brand: "Usa un color en formato #rrggbb.",
  accent: "Usa un color en formato #rrggbb.",
  email: "Escribe un correo válido, por ejemplo turismo@municipio.gob.bo.",
  phone: "Usa solo números, espacios, paréntesis o guiones; puede empezar con +.",
  address: "La dirección admite una línea de hasta 160 caracteres.",
  description: "La descripción admite hasta 160 caracteres, en una línea.",
  nearbyRadius: `Escribe un número entero de metros entre ${NEARBY_RADIUS.min} y ${NEARBY_RADIUS.max}, o déjalo vacío para usar ${NEARBY_RADIUS.default} m.`,
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
