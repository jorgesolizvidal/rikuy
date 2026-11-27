import type { OpeningHours } from "../plan/hours";
import type { AssistantLanguage } from "./language";

/**
 * «Hablar con una persona» (ADR-073). Who answers a visitor who asks for a person, the
 * message they send (written for them, sent by them), and how a typed «quiero hablar con una
 * persona» is recognized. Plain functions: the browser uses them too.
 */

/** «Atención al visitante» and the portal's phone and email. */
export interface HelpDeskContact {
  /** The help desk's name («Oficina de turismo»); null: the municipality's team. */
  readonly name: string | null;
  /** International, for a wa.me link. */
  readonly whatsapp: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  /** In the municipality's time; null: no hours published. */
  readonly hours: OpeningHours | null;
}

interface PresentationContact {
  readonly contact: { readonly phone?: string | undefined; readonly email?: string | undefined };
  readonly helpDesk?:
    | {
        readonly name: string;
        readonly whatsapp?: string | undefined;
        readonly hours?: OpeningHours | undefined;
      }
    | undefined;
}

const clean = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/** The municipality's help desk; null when there is no way to reach a person. */
export function helpDeskOf(presentation: PresentationContact): HelpDeskContact | null {
  const desk = presentation.helpDesk;
  const contact: HelpDeskContact = {
    name: clean(desk?.name),
    whatsapp: clean(desk?.whatsapp),
    phone: clean(presentation.contact.phone),
    email: clean(presentation.contact.email),
    hours: desk?.hours ?? null,
  };
  return contact.whatsapp || contact.phone || contact.email ? contact : null;
}

/** «la Oficina de turismo» has its own name; without one, the municipality's team. */
export function helpDeskName(desk: HelpDeskContact, lang: AssistantLanguage): string {
  if (desk.name) return desk.name;
  return lang === "en" ? "the municipality's team" : "el equipo del municipio";
}

/** What the visitor sends, already written: «Hola, vi el portal de… Mi consulta: …». */
export function handoffMessage(
  siteName: string,
  question: string | null,
  lang: AssistantLanguage,
): string {
  const asked = question?.replace(/\s+/gu, " ").trim() ?? "";
  if (lang === "en") {
    return asked
      ? `Hello, I saw the ${siteName} portal. My question: ${asked}`
      : `Hello, I saw the ${siteName} portal and I have a question.`;
  }
  return asked
    ? `Hola, vi el portal de ${siteName}. Mi consulta: ${asked}`
    : `Hola, vi el portal de ${siteName} y tengo una consulta.`;
}

/** A wa.me link with the message written: the international number, digits only. */
export function whatsappMessageHref(whatsapp: string, text: string): string {
  return `https://wa.me/${whatsapp.replace(/\D/gu, "")}?text=${encodeURIComponent(text)}`;
}

export function phoneHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/gu, "")}`;
}

/** The email with its subject and the same message. */
export function emailMessageHref(
  email: string,
  siteName: string,
  text: string,
  lang: AssistantLanguage,
): string {
  const subject =
    lang === "en"
      ? `Question from the ${siteName} portal`
      : `Consulta desde el portal de ${siteName}`;
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
}

/** The longest message read as a request for a person: a longer one is a question. */
const HANDOFF_MAX_LENGTH = 160;

const PERSON = String.raw`(?:una |un |alguna |algun |la |el )?(?:persona|humano|humana|alguien|operador|operadora|agente|asesor|asesora|encargado|encargada|funcionario|funcionaria|oficina|atencion)`;
const HANDOFF_PATTERNS: readonly RegExp[] = [
  new RegExp(
    String.raw`\b(?:hablar|hable|comunicarme|comunicar|conversar|contactar|contactarme|chatear|escribir|escribirle)\b(?: [a-z]+){0,3} (?:con|a) ${PERSON}\b`,
    "u",
  ),
  new RegExp(
    String.raw`\b(?:pasame|pasarme|comunicame|derivame|conectame|ponme)\b(?: [a-z]+){0,2} (?:con|a) ${PERSON}\b`,
    "u",
  ),
  /\bcon quien (?:puedo |podria |debo )?(?:hablar|comunicarme)\b/u,
  /\batencion (?:humana|personal|al visitante|al turista)\b/u,
  /\bquiero (?:una persona|un humano|un operador|un agente)\b/u,
  /\b(?:talk|speak|chat)\b(?: [a-z]+){0,3} (?:to|with) (?:a |an |some |the |your )?(?:person|human|someone|somebody|agent|operator|representative|staff|office)\b/u,
  /\b(?:human|live|real) (?:agent|person|support|being)\b/u,
  /\bcontact (?:a |the |your )?(?:person|human|office|staff|someone)\b/u,
];

function normalized(text: string): string {
  return text
    .toLocaleLowerCase("es")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** «Quiero hablar con una persona», «¿puedo hablar con alguien?», «talk to a human». */
export function detectHandoff(question: string): boolean {
  if (question.length > HANDOFF_MAX_LENGTH) return false;
  const text = normalized(question);
  return HANDOFF_PATTERNS.some((pattern) => pattern.test(text));
}
