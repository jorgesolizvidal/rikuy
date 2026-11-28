import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import {
  EnvValidationError,
  parseAiEnv,
  parseWhatsAppEnv,
  type AiEnv,
  type WhatsAppEnv,
} from "@rikuy/config/env";
import {
  createSimulatedAiProvider,
  createSimulatedTranscriber,
  runAiRequest,
  runAiSession,
  type AiCall,
  type AiLogger,
  type AiProvider,
  type AiRequestInput,
  type AiResult,
  type AiSessionInput,
  type AiSessionResult,
  type AssistantActionReport,
  type AssistantChannelKey,
  type AssistantTurnRecord,
  type DictationInput,
  type DictationResult,
  type KnowledgePassage,
  type SpeechTranscriber,
  type TourGuideContext,
  transcribeDictation,
  type UnansweredQuestion,
  type WhatsAppBegin,
} from "@rikuy/core";
import {
  createGroqProvider,
  createGroqTranscriber,
  createPostgresAiLedger,
  createWhatsAppCloud,
  type PostgresAiLedger,
  type WhatsAppCloud,
} from "@rikuy/db/ai";

/**
 * The AI gateway (ADR-036). The only module that opens the AI workload's database
 * connection (role rikuy_ai) and holds the provider key: ESLint forbids both anywhere else.
 * Every request — the visitor's assistant (P5 · Paso 3), its dictation (Paso 6), the staff's
 * (Paso 7) and the operator's «Probar la IA» — goes through this module.
 *
 * Without its settings there is no AI and nothing else changes: the result says so and the
 * portal shows its notice.
 *
 * WhatsApp (ADR-075) lives here too: its messages are answered by the same assistant through
 * the same connection, and its access token and app secret are as sensitive as the provider
 * key. They reach no other module.
 */

/** One structured line per event (Vercel logs). Never questions, answers or keys. */
const jsonAiLogger: AiLogger = {
  event(name, fields) {
    const level =
      name === "ai.begin_failed" ||
      name === "ai.finish_failed" ||
      name === "ai.setup_failed" ||
      name === "ai.unanswered_failed"
        ? "warn"
        : "info";
    console.log(JSON.stringify({ level, event: name, ...fields, at: new Date().toISOString() }));
  },
};

type Settings =
  | { readonly env: AiEnv; readonly invalidKeys: null }
  | { readonly env: null; readonly invalidKeys: readonly string[] | null };

function settings(): Settings {
  try {
    const env = parseAiEnv();
    return env === null ? { env: null, invalidKeys: null } : { env, invalidKeys: null };
  } catch (error) {
    // A half-made configuration is a mistake to fix, not a reason to break pages: the
    // operator sees which variable is wrong and the log says the same (names, never values).
    if (error instanceof EnvValidationError) {
      console.log(
        JSON.stringify({ level: "warn", event: "ai.misconfigured", keys: error.invalidKeys }),
      );
      return { env: null, invalidKeys: error.invalidKeys };
    }
    throw error;
  }
}

export interface AiGatewayStatus {
  readonly configured: boolean;
  /** Variables set but unusable (names only), so the operator knows what to fix. */
  readonly invalidKeys: readonly string[];
  readonly provider: string | null;
  readonly model: string | null;
  /** The speech model of dictation (ADR-041). */
  readonly transcriptionModel: string | null;
}

export function aiGatewayStatus(): AiGatewayStatus {
  const { env, invalidKeys } = settings();
  if (env === null)
    return {
      configured: false,
      invalidKeys: invalidKeys ?? [],
      provider: null,
      model: null,
      transcriptionModel: null,
    };
  return {
    configured: true,
    invalidKeys: [],
    provider: env.AI_PROVIDER,
    model: env.AI_PROVIDER === "simulated" ? createSimulatedAiProvider().model : env.AI_MODEL,
    transcriptionModel:
      env.AI_PROVIDER === "simulated"
        ? createSimulatedTranscriber().model
        : env.AI_TRANSCRIPTION_MODEL,
  };
}

// Kept across requests of a warm function: one small pool, reconnected by postgres.js.
let ledger: PostgresAiLedger | null = null;
let ledgerUrl: string | null = null;

function ledgerFor(env: AiEnv): PostgresAiLedger {
  if (ledger === null || ledgerUrl !== env.AI_DATABASE_URL) {
    ledger = createPostgresAiLedger({
      url: env.AI_DATABASE_URL,
      maxConnections: 2,
      ...(env.AI_DATABASE_ROLE ? { role: env.AI_DATABASE_ROLE } : {}),
    });
    ledgerUrl = env.AI_DATABASE_URL;
  }
  return ledger;
}

function providerFor(env: AiEnv): AiProvider | null {
  if (env.AI_PROVIDER === "simulated") return createSimulatedAiProvider();
  return env.GROQ_API_KEY
    ? createGroqProvider({ apiKey: env.GROQ_API_KEY, model: env.AI_MODEL })
    : null;
}

function transcriberFor(env: AiEnv): SpeechTranscriber | null {
  if (env.AI_PROVIDER === "simulated") return createSimulatedTranscriber();
  return env.GROQ_API_KEY
    ? createGroqTranscriber({ apiKey: env.GROQ_API_KEY, model: env.AI_TRANSCRIPTION_MODEL })
    : null;
}

function depsFor(env: AiEnv): {
  ledger: PostgresAiLedger;
  provider: AiProvider | null;
  transcriber: SpeechTranscriber | null;
} | null {
  try {
    return { ledger: ledgerFor(env), provider: providerFor(env), transcriber: transcriberFor(env) };
  } catch (error) {
    // Whatever the configuration, the AI never breaks the page that asked: no AI this time.
    jsonAiLogger.event("ai.setup_failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    ledger = null;
    ledgerUrl = null;
    return null;
  }
}

export async function runAi(input: AiRequestInput): Promise<AiResult> {
  const { env } = settings();
  const deps = env === null ? null : depsFor(env);
  if (deps === null) return { outcome: "not_configured", requestId: null };
  return runAiRequest(input, { ...deps, logger: jsonAiLogger });
}

/** One dictation of the visitor's assistant (ADR-041): seconds of audio, then text. */
export async function transcribeAudio(input: DictationInput): Promise<DictationResult> {
  const { env } = settings();
  const deps = env === null ? null : depsFor(env);
  return transcribeDictation(input, {
    ledger: deps?.ledger ?? null,
    transcriber: deps?.transcriber ?? null,
    logger: jsonAiLogger,
  });
}

/** A request that may call the model more than once (the visitor's assistant, ADR-038). */
export async function runAiWork<T>(
  input: AiSessionInput,
  work: (call: AiCall) => Promise<T>,
): Promise<AiSessionResult<T>> {
  const { env } = settings();
  const deps = env === null ? null : depsFor(env);
  if (deps === null) return { outcome: "not_configured", requestId: null };
  return runAiSession(input, { ...deps, logger: jsonAiLogger }, work);
}

/** What the assistant may read now (ai_api.search_knowledge through the AI role). */
export async function searchAiKnowledge(
  tenantId: string,
  query: string,
  limit: number,
): Promise<KnowledgePassage[]> {
  const { env } = settings();
  const deps = env === null ? null : depsFor(env);
  if (deps === null) return [];
  return deps.ledger.searchKnowledge(tenantId, query, limit);
}

/**
 * ai_api.record_unanswered_question (ADR-053): keeps, for the municipality, a question the
 * assistant just could not answer. Called after the answer is sent; a failure is logged (the
 * outcome only, never the text) and the visitor never notices.
 */
export async function recordUnansweredQuestion(
  tenantId: string,
  question: UnansweredQuestion,
): Promise<void> {
  const { env } = settings();
  const deps = env === null ? null : depsFor(env);
  if (deps === null) return;
  try {
    const outcome = await deps.ledger.recordUnansweredQuestion(tenantId, question);
    jsonAiLogger.event("ai.unanswered_recorded", { outcome });
  } catch (error) {
    jsonAiLogger.event("ai.unanswered_failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

/**
 * ai_api.record_person_request (ADR-073): the visitor took an answer's question to a person.
 * Never fails the visitor: an error only leaves a log line, without the question.
 */
export async function recordPersonRequest(
  tenantId: string,
  visitor: string | null,
  question: UnansweredQuestion,
): Promise<void> {
  const { env } = settings();
  const deps = env === null ? null : depsFor(env);
  if (deps === null) return;
  try {
    const outcome = await deps.ledger.recordPersonRequest(tenantId, visitor, question);
    jsonAiLogger.event("ai.person_request_recorded", { outcome });
  } catch (error) {
    jsonAiLogger.event("ai.person_request_failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

/**
 * ai_api.record_assistant_turn (ADR-074): an answer with its channel, kind and citations,
 * after it is on its way. A failure only leaves a log line.
 */
export async function recordAssistantTurn(
  tenantId: string,
  channel: AssistantChannelKey,
  turn: AssistantTurnRecord,
): Promise<void> {
  const { env } = settings();
  const deps = env === null ? null : depsFor(env);
  if (deps === null) return;
  try {
    const outcome = await deps.ledger.recordAssistantTurn(tenantId, channel, turn);
    jsonAiLogger.event("ai.turn_recorded", { outcome, kind: turn.kind, channel });
  } catch (error) {
    jsonAiLogger.event("ai.turn_failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

/** ai_api.record_assistant_action (ADR-074): what the visitor tapped in an answer. */
export async function recordAssistantAction(
  tenantId: string,
  visitor: string | null,
  action: AssistantActionReport,
): Promise<void> {
  const { env } = settings();
  const deps = env === null ? null : depsFor(env);
  if (deps === null) return;
  try {
    const outcome = await deps.ledger.recordAssistantAction(tenantId, visitor, action);
    jsonAiLogger.event("ai.action_recorded", { outcome, action: action.action });
  } catch (error) {
    jsonAiLogger.event("ai.action_failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

/** ai_api.tour_context (ADR-040): the tour's scene and point, checked against what is published. */
/**
 * ai_api.place_notices (ADR-069): the notices in force that name the destination or event the
 * visitor is on. Nothing without the AI configured.
 */
export async function aiPlaceNotices(
  tenantId: string,
  item: { readonly kind: "destination" | "event"; readonly slug: string },
): Promise<KnowledgePassage[]> {
  const { env } = settings();
  const deps = env === null ? null : depsFor(env);
  if (deps === null) return [];
  return deps.ledger.placeNotices(tenantId, item);
}

export async function aiTourContext(
  tenantId: string,
  item: { readonly kind: "destination" | "event"; readonly slug: string },
  sceneId: string | null,
  hotspotId: string | null,
): Promise<TourGuideContext | null> {
  const { env } = settings();
  const deps = env === null ? null : depsFor(env);
  if (deps === null) return null;
  return deps.ledger.tourContext(tenantId, item, sceneId, hotspotId);
}

// ── WhatsApp (A · Paso 6, ADR-075) ──────────────────────────────────────────────────────

type WhatsAppSettings =
  | { readonly env: WhatsAppEnv; readonly invalidKeys: null }
  | { readonly env: null; readonly invalidKeys: readonly string[] | null };

function whatsappSettings(): WhatsAppSettings {
  try {
    const env = parseWhatsAppEnv();
    return env === null ? { env: null, invalidKeys: null } : { env, invalidKeys: null };
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.log(
        JSON.stringify({ level: "warn", event: "whatsapp.misconfigured", keys: error.invalidKeys }),
      );
      return { env: null, invalidKeys: error.invalidKeys };
    }
    throw error;
  }
}

export interface WhatsAppStatus {
  /** Meta's token, app secret and verify token are set, and the AI is too. */
  readonly configured: boolean;
  readonly invalidKeys: readonly string[];
}

export function whatsappStatus(): WhatsAppStatus {
  const { env, invalidKeys } = whatsappSettings();
  return { configured: env !== null && settings().env !== null, invalidKeys: invalidKeys ?? [] };
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Meta's subscription check (GET hub.mode=subscribe&hub.verify_token=…&hub.challenge=…): the
 * challenge to echo when the token is ours, otherwise null.
 */
export function whatsappChallenge(
  mode: string | null,
  token: string | null,
  challenge: string | null,
): string | null {
  const { env } = whatsappSettings();
  if (env === null || mode !== "subscribe" || token === null || challenge === null) return null;
  if (!/^[0-9A-Za-z_-]{1,200}$/u.test(challenge)) return null;
  return sameSecret(token, env.WHATSAPP_VERIFY_TOKEN) ? challenge : null;
}

/** X-Hub-Signature-256: HMAC-SHA256 of the raw body with the app secret. */
export function whatsappSignatureValid(body: Uint8Array, header: string | null): boolean {
  const { env } = whatsappSettings();
  if (env === null || header === null || !/^sha256=[0-9a-f]{64}$/u.test(header)) return false;
  const expected = `sha256=${createHmac("sha256", env.WHATSAPP_APP_SECRET).update(body).digest("hex")}`;
  return sameSecret(header, expected);
}

let cloud: WhatsAppCloud | null = null;
let cloudToken: string | null = null;

function cloudFor(env: WhatsAppEnv): WhatsAppCloud {
  if (cloud === null || cloudToken !== env.WHATSAPP_ACCESS_TOKEN) {
    cloud = createWhatsAppCloud({
      accessToken: env.WHATSAPP_ACCESS_TOKEN,
      ...(env.WHATSAPP_GRAPH_URL ? { graphUrl: env.WHATSAPP_GRAPH_URL } : {}),
    });
    cloudToken = env.WHATSAPP_ACCESS_TOKEN;
  }
  return cloud;
}

/** ai_api.whatsapp_begin: the municipality of the number, once per message. */
export async function whatsappBegin(
  phoneNumberId: string,
  messageId: string,
  waId: string,
): Promise<WhatsAppBegin> {
  const { env } = settings();
  const deps = env === null ? null : depsFor(env);
  if (deps === null) return { status: "unavailable" };
  return deps.ledger.whatsappBegin(phoneNumberId, messageId, waId);
}

/** ai_api.whatsapp_remember: the conversation's last messages, masked. */
export async function whatsappRemember(
  tenantId: string,
  contactKey: string,
  question: string,
  answer: string,
): Promise<void> {
  const { env } = settings();
  const deps = env === null ? null : depsFor(env);
  if (deps === null) return;
  await deps.ledger.whatsappRemember(tenantId, contactKey, question, answer);
}

export async function sendWhatsAppText(
  phoneNumberId: string,
  to: string,
  text: string,
): Promise<void> {
  const { env } = whatsappSettings();
  if (env === null) throw new Error("WhatsApp is not configured");
  await cloudFor(env).sendText(phoneNumberId, to, text);
}

/** A voice note's bytes; null when it is larger than a dictation may be. */
export async function downloadWhatsAppAudio(mediaId: string): Promise<Uint8Array | null> {
  const { env } = whatsappSettings();
  if (env === null) throw new Error("WhatsApp is not configured");
  const media = await cloudFor(env).downloadMedia(mediaId);
  return media?.bytes ?? null;
}

export const whatsappLogger = jsonAiLogger;
