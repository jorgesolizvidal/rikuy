import type { AssistantLanguage } from "./language";
import type { AssistantPage } from "./page";

/**
 * What visitors ask without an answer (C1 · Paso 3, ADR-053). Only the questions the
 * assistant could not answer from what is published are kept — never who asked — and before
 * that, the personal data a visitor may have typed is masked. The database masks again
 * (emails, links, six digits in a row) whatever reaches it.
 */

/** The longest question kept (the visitor's question is at most 500 characters, ADR-038). */
export const UNANSWERED_MAX_LENGTH = 500;

export interface UnansweredQuestion {
  /** The gateway request that could not answer it (ADR-036). */
  readonly requestId: string;
  /** Masked, without a greeting in front, at most 500 characters. */
  readonly question: string;
  readonly lang: AssistantLanguage;
  readonly page: AssistantPage;
  /** Inside a tour: the scene on screen (the database keeps it only if that tour has it). */
  readonly sceneId: string | null;
}

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
const LINK = /\b(?:https?:\/\/|www\.)[^\s]+/giu;
/** An international number: «+591 712 34567», «+54 (11) 4567-8901». */
const INTERNATIONAL = /\+\s?\d(?:[\s().-]{0,2}\d){6,}/gu;
/** Six or more digits, maybe split by single spaces, dots or dashes. */
const DIGITS = /\d(?:[\s.-]?\d){5,}/gu;
/** A date or a range of years is not personal: «15-11-2026», «2025-2026». */
const DATE = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/u;
const YEARS = /^(?:19|20)\d{2}\s?-\s?(?:19|20)\d{2}$/u;

function maskDigits(match: string): string {
  if (DATE.test(match) || YEARS.test(match)) return match;
  const digits = match.replace(/\D/gu, "");
  // A Bolivian mobile number: eight digits starting with 6 or 7.
  if (digits.length === 8 && /^[67]/u.test(digits)) return "[teléfono]";
  return "[número]";
}

/**
 * Emails, links, phone numbers and long numbers (an identity card, an account) become
 * [correo], [enlace], [teléfono] and [número]. A name cannot be told apart safely and stays.
 */
export function maskPersonalData(text: string): string {
  return text
    .replace(EMAIL, "[correo]")
    .replace(LINK, "[enlace]")
    .replace(INTERNATIONAL, "[teléfono]")
    .replace(DIGITS, maskDigits);
}

/** The words of a question without case, accents or punctuation (as the database groups). */
export function questionWords(text: string): string[] {
  return text
    .toLocaleLowerCase("es")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .split(/[^a-z0-9]+/u)
    .filter((word) => word !== "");
}

const SMALL_TALK = new Set([
  "hola",
  "holi",
  "buenas",
  "buenos",
  "buen",
  "dia",
  "dias",
  "tardes",
  "noches",
  "gracias",
  "muchas",
  "mil",
  "ok",
  "okay",
  "vale",
  "listo",
  "chau",
  "chao",
  "adios",
  "saludos",
  "genial",
  "perfecto",
  "excelente",
  "bien",
  "muy",
  "si",
  "no",
  "hello",
  "hi",
  "hey",
  "thanks",
  "thank",
  "you",
  "bye",
  "good",
  "morning",
  "afternoon",
  "evening",
  "great",
  "yes",
]);

/** «Hola», «muchas gracias», «ok»: nothing to publish about. */
export function isSmallTalk(text: string): boolean {
  const words = questionWords(text);
  return words.length > 0 && words.every((word) => SMALL_TALK.has(word));
}

/** «Hola, ¿hay wifi?» is kept as «¿hay wifi?», so it groups with the same question. */
const GREETING =
  /^\s*(?:hola|buenas(?:\s+(?:tardes|noches))?|buen(?:os)?\s+d[ií]as|hello|hi|hey)\b[\s,.;:!¡]*/iu;

/**
 * The text kept for a question: without a greeting in front, masked, in one line, at most
 * 500 characters. Null when nothing worth keeping is left (empty or only small talk).
 */
export function unansweredText(question: string): string | null {
  if (isSmallTalk(question)) return null;
  const text = maskPersonalData(question.replace(GREETING, ""))
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, UNANSWERED_MAX_LENGTH)
    .trim();
  return questionWords(text).length === 0 ? null : text;
}
