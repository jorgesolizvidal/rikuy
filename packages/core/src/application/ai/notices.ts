import type { AiRefusal } from "../../contracts/ai";
import type { AssistantLanguage } from "../../domain/assistant/language";
import { PORTAL_PATHS } from "../content/portal";

/**
 * What the visitor sees when the assistant cannot answer (ADR-036): never an error, the
 * assistant's own voice and something useful instead. The rest of the portal is unchanged.
 */
export interface AiNotice {
  /** Who speaks: the municipality's assistant, or a neutral name. */
  readonly speaker: string;
  readonly message: string;
  /** When asking again makes sense. */
  readonly retry: "tomorrow" | "later" | "minutes" | "unknown";
  readonly links: readonly { readonly label: string; readonly href: string }[];
  /** The municipality's tourism contact, from its brand. */
  readonly contact: { readonly phone?: string; readonly email?: string } | null;
}

export const NEUTRAL_ASSISTANT_NAME = "El asistente";

/** The same notices for a question asked in English (ADR-038). */
const ENGLISH: Readonly<Record<AiRefusal, string>> = {
  tenant_quota:
    "I have answered all the questions I could for today. Please come back tomorrow; meanwhile, this may help:",
  platform_quota:
    "I have answered all the questions I could for today. Please come back tomorrow; meanwhile, this may help:",
  visitor_limit:
    "I have answered many of your questions in the last hour. Please come back in a while; meanwhile, this may help:",
  provider_unavailable:
    "I am not available right now. Please try again in a few minutes; meanwhile, this may help:",
  provider_error: "I am not available for now. Meanwhile, this may help:",
  tenant_unavailable: "I am not available for now. Meanwhile, this may help:",
  not_configured: "I am not available for now. Meanwhile, this may help:",
};

const LINK_LABELS = {
  es: { destinations: "Destinos", agenda: "Agenda", map: "Mapa", tours: "Tours 360°" },
  en: { destinations: "Places", agenda: "Events", map: "Map", tours: "360° tours" },
} as const;

/** The portal's sections, as links the visitor can open instead of an answer. */
export function portalSectionLinks(
  lang: AssistantLanguage,
  hasTours: boolean,
): { readonly label: string; readonly href: string }[] {
  const labels = LINK_LABELS[lang];
  return [
    { label: labels.destinations, href: PORTAL_PATHS.destinations },
    { label: labels.agenda, href: PORTAL_PATHS.agenda },
    { label: labels.map, href: PORTAL_PATHS.map },
    ...(hasTours ? [{ label: labels.tours, href: PORTAL_PATHS.generalTour }] : []),
  ];
}

const MESSAGES: Readonly<Record<AiRefusal, { message: string; retry: AiNotice["retry"] }>> = {
  tenant_quota: {
    message:
      "Por hoy ya respondí todas las preguntas que podía. Vuelve mañana; mientras tanto, esto te puede servir:",
    retry: "tomorrow",
  },
  // Same words: the visitor does not need to know whose limit it was.
  platform_quota: {
    message:
      "Por hoy ya respondí todas las preguntas que podía. Vuelve mañana; mientras tanto, esto te puede servir:",
    retry: "tomorrow",
  },
  visitor_limit: {
    message:
      "Ya respondí muchas preguntas tuyas en la última hora. Vuelve en un rato; mientras tanto, esto te puede servir:",
    retry: "later",
  },
  provider_unavailable: {
    message:
      "No estoy disponible en este momento. Prueba en unos minutos; mientras tanto, esto te puede servir:",
    retry: "minutes",
  },
  provider_error: {
    message: "No estoy disponible por ahora. Mientras tanto, esto te puede servir:",
    retry: "unknown",
  },
  tenant_unavailable: {
    message: "No estoy disponible por ahora. Mientras tanto, esto te puede servir:",
    retry: "unknown",
  },
  not_configured: {
    message: "No estoy disponible por ahora. Mientras tanto, esto te puede servir:",
    retry: "unknown",
  },
};

export function aiNotice(
  outcome: AiRefusal,
  context: {
    /** The municipality's assistant name (its brand); none: a neutral one. */
    readonly assistantName?: string | null;
    readonly contact?: {
      readonly phone?: string | undefined;
      readonly email?: string | undefined;
    } | null;
    /** The municipality has visible tours (the general tour link would work). */
    readonly hasTours?: boolean;
    /** The language of the question (Spanish by default). */
    readonly lang?: AssistantLanguage;
  } = {},
): AiNotice {
  const lang = context.lang ?? "es";
  const { retry } = MESSAGES[outcome];
  const message = lang === "en" ? ENGLISH[outcome] : MESSAGES[outcome].message;
  const links = portalSectionLinks(lang, context.hasTours ?? false);
  const phone = context.contact?.phone?.trim();
  const email = context.contact?.email?.trim();
  return {
    speaker: context.assistantName?.trim() || NEUTRAL_ASSISTANT_NAME,
    message,
    retry,
    links,
    contact: phone || email ? { ...(phone ? { phone } : {}), ...(email ? { email } : {}) } : null,
  };
}
