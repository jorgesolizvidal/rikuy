import type { AiRefusal } from "../../contracts/ai";
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
    readonly contact?: { readonly phone?: string; readonly email?: string } | null;
    /** The municipality has visible tours (the general tour link would work). */
    readonly hasTours?: boolean;
  } = {},
): AiNotice {
  const { message, retry } = MESSAGES[outcome];
  const links = [
    { label: "Destinos", href: PORTAL_PATHS.destinations },
    { label: "Agenda", href: PORTAL_PATHS.agenda },
    { label: "Mapa", href: PORTAL_PATHS.map },
    ...(context.hasTours ? [{ label: "Tours 360°", href: PORTAL_PATHS.generalTour }] : []),
  ];
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
