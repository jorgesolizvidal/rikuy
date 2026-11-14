import {
  ASSISTANT_TONES,
  HERO_VARIANTS,
  HOME_SECTION_KEYS,
  HOME_SECTIONS,
  homeOf,
  isHomeVariant,
  type HeroVariant,
  type HomeSectionKey,
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
  /** The portal's home (ADR-062). */
  home: HomeValues;
}

/** One line per section of the catalog, in the home's order; hidden ones keep their place. */
export interface HomeSectionValues {
  readonly key: HomeSectionKey;
  readonly shown: boolean;
  readonly variant: string;
}

export interface HomeValues {
  readonly heroVariant: HeroVariant;
  /** The cover's destination id; empty: the first destination that has a photo. */
  readonly heroDestination: string;
  /** Two figures written by the municipality; both fields empty: no figure. */
  readonly figures: readonly [HomeFigureValues, HomeFigureValues];
  readonly sections: readonly HomeSectionValues[];
}

export interface HomeFigureValues {
  readonly value: string;
  readonly label: string;
}

export type BrandingField =
  | Exclude<keyof BrandingValues, "social" | "logoAssetId" | "logoVersion" | "home">
  | `social.${SocialNetwork}`
  | "logo"
  | "homeHero"
  | "homeFigure1"
  | "homeSections";

/** The form's home: the brand's own, or the platform's default, every section listed. */
export function homeValues(presentation: TenantPresentation): HomeValues {
  const home = homeOf(presentation);
  const listed = home.sections.map((section) => ({
    key: section.key,
    shown: true,
    variant: section.variant,
  }));
  // The sections it leaves out, after the rest, hidden, in their default variant.
  const missing = HOME_SECTIONS.filter(
    (section) => !home.sections.some((item) => item.key === section.key),
  ).map((section) => ({ key: section.key, shown: false, variant: section.variants[0]?.key ?? "" }));
  const figure = (index: number): HomeFigureValues => ({
    value: home.figures[index]?.value ?? "",
    label: home.figures[index]?.label ?? "",
  });
  return {
    heroVariant: home.hero.variant,
    heroDestination: home.hero.destinationId ?? "",
    figures: [figure(0), figure(1)],
    sections: [...listed, ...missing],
  };
}

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
    home: homeValues(presentation),
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
    ...homeFromForm(formData),
  };
}

/**
 * The home from its fields (ADR-062). A form without them (a page opened before this step)
 * leaves the brand's home out: the portal then shows the platform's default.
 */
function homeFromForm(formData: FormData) {
  if (!formData.has("home.hero.variant")) return {};
  const variant = text(formData, "home.hero.variant");
  const destination = text(formData, "home.hero.destination");
  const figures = [1, 2].flatMap((n) => {
    const value = text(formData, `home.figure.${String(n)}.value`);
    const label = text(formData, `home.figure.${String(n)}.label`);
    // Both empty: no figure. Only one: kept, so validation says what is missing.
    return value === "" && label === "" ? [] : [{ value, label }];
  });
  const order = formData
    .getAll("home.order")
    .filter((key): key is HomeSectionKey =>
      (HOME_SECTION_KEYS as readonly unknown[]).includes(key),
    );
  const sections = order
    .filter((key) => formData.get(`home.show.${key}`) === "on")
    .map((key) => {
      const chosen = text(formData, `home.variant.${key}`);
      return { key, variant: isHomeVariant(key, chosen) ? chosen : "" };
    });
  return {
    home: {
      hero: {
        variant: (HERO_VARIANTS as readonly string[]).includes(variant) ? variant : "",
        destinationId: destination === "" ? null : destination,
      },
      figures,
      sections,
    },
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
  home: "homeHero",
  "home.hero": "homeHero",
  "home.hero.variant": "homeHero",
  "home.hero.destinationId": "homeHero",
  "home.figures": "homeFigure1",
  "home.figures.0": "homeFigure1",
  "home.figures.0.value": "homeFigure1",
  "home.figures.0.label": "homeFigure1",
  // Empty rows are left out, so the index is not the row on screen: one message for both.
  "home.figures.1": "homeFigure1",
  "home.figures.1.value": "homeFigure1",
  "home.figures.1.label": "homeFigure1",
  "home.sections": "homeSections",
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
  homeHero: "Elige la portada: con foto o solo texto.",
  homeFigure1:
    "En cada cifra escribe el número o dato (hasta 12 caracteres, como «1953») y qué es (hasta 60), o deja los dos vacíos.",
  homeSections: "Elige una variante para cada sección que se muestra.",
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
    if (field === undefined && issue.path.startsWith("home.sections")) field = "homeSections";
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
