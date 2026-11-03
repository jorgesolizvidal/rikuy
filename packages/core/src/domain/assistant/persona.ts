import type { AssistantTone, TenantPresentation } from "../../contracts/presentation";

/**
 * The assistant's persona (ADR-022, ADR-038): its name, greeting and tone are the
 * municipality's brand data. Without them, a neutral assistant. No municipality or
 * assistant name lives in the code.
 */
export const NEUTRAL_ASSISTANT_LABEL = "Asistente";

export interface AssistantPersona {
  /** What the button and the conversation show. */
  readonly name: string;
  /** False: the neutral assistant (the brand has no name for it). */
  readonly named: boolean;
  readonly greeting: string;
  readonly tone: AssistantTone;
}

export function assistantPersona(presentation: TenantPresentation): AssistantPersona {
  const site = presentation.identity.siteName;
  const configured = presentation.assistant;
  const tone = configured?.tone ?? "warm";
  const name = configured?.name.trim() || NEUTRAL_ASSISTANT_LABEL;
  const named = Boolean(configured?.name.trim());
  const own = configured?.greeting.trim();
  if (own) return { name, named, greeting: own, tone };
  const who = named ? name : `el asistente de ${site}`;
  const greeting =
    tone === "formal"
      ? `Bienvenido. Soy ${who}: puedo responder sus preguntas sobre lugares, eventos e historia${named ? ` de ${site}` : ""}.`
      : `¡Hola! Soy ${who}. Pregúntame lo que quieras sobre lugares, eventos e historia${named ? ` de ${site}` : ""}.`;
  return { name, named, greeting, tone };
}
