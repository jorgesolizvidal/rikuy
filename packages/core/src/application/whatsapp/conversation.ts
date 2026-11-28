import type { DictationReply } from "../../contracts/voice";
import type { AssistantTurn } from "../../domain/assistant/prompts";
import { ASSISTANT_LIMITS } from "../../domain/assistant/limits";
import { distanceMeters } from "../../domain/geo/proximity";
import type { WhatsAppInbound } from "../../domain/whatsapp/webhook";
import type { AssistantResult } from "../assistant/ask";
import type { AssistantPlaces } from "../assistant/plan";
import { whatsappMemoryText } from "./format";

/**
 * One message to a municipality's WhatsApp number (A · Paso 6, ADR-075), answered by the same
 * assistant as the portal. The municipality is the one the number belongs to (the database
 * says so); the message is answered once; the conversation keeps its last six messages for
 * 24 hours under a keyed hash of the sender's number. A voice note is passed to text first and
 * the answer says what was understood; a shared location becomes distances to what is
 * published, used for «¿Qué hay cerca?» and then forgotten: neither the position nor the
 * number reaches the model.
 */

export type WhatsAppBegin =
  | {
      readonly status: "new";
      readonly tenantId: string;
      /** The portal's host of the municipality (its canonical domain). */
      readonly host: string;
      /** The sender, as a keyed hash: the gateway's visitor and the conversation's key. */
      readonly contactKey: string;
      readonly history: readonly AssistantTurn[];
    }
  | { readonly status: "duplicate" | "unknown_number" | "unavailable" | "capped" };

/** The assistant of the municipality the message is for. */
export interface WhatsAppAssistant {
  ask(request: unknown, visitor: string): Promise<AssistantResult>;
  /** Null when the municipality has no voice (ADR-060) or the platform has no transcriber. */
  readonly transcribe: ((mediaId: string, visitor: string) => Promise<DictationReply>) | null;
  /** What a plan may include, to measure the distances of a shared location. */
  places(): Promise<AssistantPlaces>;
  /** The answer as a WhatsApp message (links decided for this municipality); null: none. */
  format(result: AssistantResult, question: string): Promise<string | null>;
  recordTurn(result: AssistantResult): Promise<void>;
  recordUnanswered(result: AssistantResult): Promise<void>;
}

export interface WhatsAppDeps {
  begin(message: WhatsAppInbound): Promise<WhatsAppBegin>;
  /** Null when the municipality does not have the assistant (ADR-060). */
  open(begun: Extract<WhatsAppBegin, { status: "new" }>): Promise<WhatsAppAssistant | null>;
  send(phoneNumberId: string, to: string, text: string): Promise<void>;
  remember(tenantId: string, contactKey: string, question: string, answer: string): Promise<void>;
}

export type WhatsAppOutcome =
  | "answered"
  | "duplicate"
  | "unknown_number"
  | "unavailable"
  | "capped"
  | "no_assistant"
  | "unsupported"
  | "no_voice"
  | "voice_failed"
  | "invalid";

export const WHATSAPP_MESSAGES = {
  unsupported:
    "Por ahora entiendo mensajes de texto, notas de voz y tu ubicación. Escríbeme tu pregunta, por favor.",
  noVoice: "Por ahora no puedo escuchar notas de voz. Escríbeme tu pregunta, por favor.",
  noAssistant:
    "Este número todavía no tiene el asistente activo. Puedes visitar el portal del municipio.",
  invalid: "No entendí tu mensaje. ¿Me lo escribes con otras palabras?",
  understood: (text: string) => `Entendí: «${text}»`,
  locationQuestion: "¿Qué hay cerca de donde estoy?",
} as const;

/** «destination:slug» → meters, the nearest first (a phone's distances, ADR-039). */
export function distancesFrom(
  places: AssistantPlaces,
  point: { readonly lat: number; readonly lng: number },
): Record<string, number> {
  const all: [string, number][] = [];
  for (const destination of places.destinations) {
    if (destination.location) {
      all.push([`destination:${destination.slug}`, distanceMeters(point, destination.location)]);
    }
  }
  for (const event of places.events) {
    if (event.location) all.push([`event:${event.slug}`, distanceMeters(point, event.location)]);
  }
  for (const service of places.services ?? []) {
    if (service.location) {
      all.push([`service:${service.slug}`, distanceMeters(point, service.location)]);
    }
  }
  return Object.fromEntries(all.sort((a, b) => a[1] - b[1]).slice(0, ASSISTANT_LIMITS.distances));
}

function questionLine(text: string): string {
  return text
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, ASSISTANT_LIMITS.question);
}

export async function answerWhatsApp(
  message: WhatsAppInbound,
  deps: WhatsAppDeps,
): Promise<WhatsAppOutcome> {
  const begun = await deps.begin(message);
  if (begun.status !== "new") return begun.status;
  const reply = (text: string) => deps.send(message.phoneNumberId, message.from, text);

  const assistant = await deps.open(begun);
  if (assistant === null) {
    await reply(WHATSAPP_MESSAGES.noAssistant);
    return "no_assistant";
  }

  const visitor = begun.contactKey;
  let question: string;
  let heard: string | null = null;
  const request: Record<string, unknown> = {
    history: begun.history,
    page: { kind: "home" },
  };

  if (message.kind === "text" && message.text !== null) {
    question = questionLine(message.text);
  } else if (message.kind === "audio" && message.mediaId !== null) {
    if (assistant.transcribe === null) {
      await reply(WHATSAPP_MESSAGES.noVoice);
      return "no_voice";
    }
    const dictation = await assistant.transcribe(message.mediaId, visitor);
    if (dictation.status !== "transcribed") {
      await reply(dictation.message);
      return "voice_failed";
    }
    question = questionLine(dictation.text);
    heard = question;
  } else if (message.kind === "location" && message.location !== null) {
    question = WHATSAPP_MESSAGES.locationQuestion;
    request.intent = "nearby";
    request.distances = distancesFrom(await assistant.places(), message.location);
  } else {
    await reply(WHATSAPP_MESSAGES.unsupported);
    return "unsupported";
  }

  if (question.length < 2) {
    await reply(WHATSAPP_MESSAGES.invalid);
    return "invalid";
  }
  request.question = question;

  const result = await assistant.ask(request, visitor);
  const text = await assistant.format(result, question);
  if (text === null) {
    await reply(WHATSAPP_MESSAGES.invalid);
    return "invalid";
  }
  await reply(heard ? `${WHATSAPP_MESSAGES.understood(heard)}\n\n${text}` : text);

  // After the answer is on its way: the conversation, the channel's metrics and, when nothing
  // published answered it, the question for the municipality. None of them may fail the visitor.
  await Promise.allSettled([
    deps.remember(begun.tenantId, visitor, question, whatsappMemoryText(result.reply)),
    assistant.recordTurn(result),
    assistant.recordUnanswered(result),
  ]);
  return "answered";
}
