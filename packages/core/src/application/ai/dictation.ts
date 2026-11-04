import type { AiRefusal } from "../../contracts/ai";
import { ASSISTANT_LIMITS } from "../../domain/assistant/limits";
import { DICTATION_LIMITS, type DictationFormat, type DictationReply } from "../../contracts/voice";
import { AiProviderError, type AiBeginOutcome, type AiExecution, type AiLogger } from "./gateway";

/**
 * Dictation (ADR-041): one recording of the visitor becomes text through the AI gateway.
 *
 *   1. the bytes must be audio of a container the provider accepts, and short;
 *   2. reserve the longest recording's seconds (municipality's day, platform's day, the
 *      visitor's dictations of the hour);
 *   3. only then call the provider, retrying once when it is down or slow;
 *   4. settle with the seconds the provider bills (at least 10 per transcription).
 *
 * The audio and the text are never stored. A refusal or a failure is a reply with a short
 * message, never an exception: the visitor types instead.
 */

/** One call to the speech provider, as recorded in ai_executions. */
export interface DictationExecution {
  readonly provider: string;
  readonly model: string;
  readonly status: AiExecution["status"];
  /** What the provider bills: 0 for a failed call. */
  readonly audioSeconds: number;
  readonly latencyMs: number;
  readonly httpStatus: number | null;
}

export type DictationFinishOutcome = "transcribed" | "provider_unavailable" | "provider_error";

/** ai_api.begin_dictation / finish_dictation, through the AI workload's own role. */
export interface DictationLedger {
  beginDictation(input: {
    readonly tenantId: string;
    readonly reserveSeconds: number;
    /** An opaque key of the visitor (the database keeps only a daily-salted hash). */
    readonly visitor: string | null;
  }): Promise<{ readonly requestId: string; readonly outcome: AiBeginOutcome }>;
  finishDictation(
    requestId: string,
    outcome: DictationFinishOutcome,
    executions: readonly DictationExecution[],
  ): Promise<void>;
}

export interface TranscriptionSegment {
  readonly text: string;
  /** The provider's confidence that the segment holds no speech (0–1). */
  readonly noSpeechProb: number | null;
}

export interface Transcription {
  readonly text: string;
  /** The recording's length as the provider measured it; null when it does not say. */
  readonly durationSeconds: number | null;
  readonly segments: readonly TranscriptionSegment[] | null;
  readonly model: string;
}

export interface SpeechTranscriber {
  /** For the records: [a-z0-9_-]. */
  readonly name: string;
  readonly model: string;
  transcribe(
    request: {
      readonly audio: Uint8Array;
      readonly format: DictationFormat;
      /** Names the provider should spell right (published places); never instructions. */
      readonly prompt: string | null;
    },
    signal: AbortSignal,
  ): Promise<Transcription>;
}

// ── The audio ───────────────────────────────────────────────────────────────

const ascii = (bytes: Uint8Array, from: number, length: number) =>
  String.fromCharCode(...bytes.subarray(from, from + length));

/** The container, from its first bytes (what the browser says is not trusted). */
export function sniffAudio(bytes: Uint8Array): DictationFormat | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)
    return "webm";
  if (ascii(bytes, 0, 4) === "OggS") return "ogg";
  if (ascii(bytes, 4, 4) === "ftyp") return "mp4";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return "wav";
  if (ascii(bytes, 0, 4) === "fLaC") return "flac";
  if (ascii(bytes, 0, 3) === "ID3") return "mpeg";
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return "mpeg";
  return null;
}

/** The file name the provider gets: it reads the container from the extension. */
export const DICTATION_FILE_NAMES: Readonly<Record<DictationFormat, string>> = {
  webm: "dictado.webm",
  ogg: "dictado.ogg",
  mp4: "dictado.m4a",
  wav: "dictado.wav",
  mpeg: "dictado.mp3",
  flac: "dictado.flac",
};

// ── The text ────────────────────────────────────────────────────────────────

/** What speech models write for silence or noise (subtitle credits from their training). */
const SILENCE_PHRASES = new Set([
  "gracias",
  "gracias por ver",
  "gracias por ver el video",
  "gracias por ver el vídeo",
  "muchas gracias por ver el video",
  "suscribete",
  "suscríbete",
  "thank you",
  "thank you for watching",
  "thanks for watching",
  "you",
]);

const normalized = (text: string) =>
  text
    .toLowerCase()
    .replace(/[¿?¡!.,;:…"«»()-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

/** Segments the provider is fairly sure hold no speech are dropped. */
const NO_SPEECH = 0.6;

/**
 * The text the visitor will review: segments with speech, one line, at most the question's
 * length. Empty when nothing was said (silence, noise, a model's stock phrase or the prompt
 * read back).
 */
export function dictationText(
  transcription: Transcription,
  prompt: string | null,
  maxLength: number = ASSISTANT_LIMITS.question,
): string {
  const spoken =
    transcription.segments && transcription.segments.length > 0
      ? transcription.segments
          .filter((segment) => (segment.noSpeechProb ?? 0) < NO_SPEECH)
          .map((segment) => segment.text)
          .join(" ")
      : transcription.text;
  const text = spoken.replace(/\s+/gu, " ").trim();
  const plain = normalized(text);
  if (plain.length < 2 || SILENCE_PHRASES.has(plain) || plain.includes("amara org")) return "";
  if (prompt && normalized(prompt).includes(plain)) return "";
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const space = cut.lastIndexOf(" ");
  return (space > maxLength * 0.6 ? cut.slice(0, space) : cut).trim();
}

/**
 * Names the provider should spell right: the municipality and its published places. Plain
 * data, short (the provider reads ~224 tokens of it).
 */
export function dictationPrompt(siteName: string, places: readonly string[], maxLength = 600) {
  let prompt = `${siteName.trim()}.`;
  for (const place of places) {
    const name = place.replace(/\s+/gu, " ").trim();
    if (!name) continue;
    const next = `${prompt} ${name}.`;
    if (next.length > maxLength) break;
    prompt = next;
  }
  return prompt;
}

// ── The messages ────────────────────────────────────────────────────────────

/** What the visitor reads next to the question's field. Never an error page. */
export const DICTATION_MESSAGES = {
  empty: "No te escuché bien. Vuelve a intentarlo cerca del micrófono o escribe tu pregunta.",
  tenant_quota: "El dictado por voz ya no está disponible por hoy. Puedes escribir tu pregunta.",
  platform_quota: "El dictado por voz ya no está disponible por hoy. Puedes escribir tu pregunta.",
  visitor_limit:
    "Ya usaste el dictado muchas veces en la última hora. Puedes escribir tu pregunta o volver a dictar en un rato.",
  unavailable: "No pude pasar tu voz a texto en este momento. Puedes escribir tu pregunta.",
  not_audio: "No pude leer esa grabación. Vuelve a intentarlo o escribe tu pregunta.",
  too_long: "La grabación es demasiado larga: dicta una pregunta corta (hasta 30 segundos).",
} as const;

function noticeFor(refusal: AiRefusal): DictationReply {
  const message =
    refusal === "tenant_quota" || refusal === "platform_quota" || refusal === "visitor_limit"
      ? DICTATION_MESSAGES[refusal]
      : DICTATION_MESSAGES.unavailable;
  return { status: "notice", message };
}

// ── The use case ────────────────────────────────────────────────────────────

export interface DictationInput {
  readonly tenantId: string;
  readonly audio: Uint8Array;
  readonly visitor: string | null;
  /** From dictationPrompt; null to send none. */
  readonly prompt: string | null;
}

export interface DictationDeps {
  /** Null on a deployment without the gateway's connection. */
  readonly ledger: DictationLedger | null;
  /** Null on a deployment without a provider key. */
  readonly transcriber: SpeechTranscriber | null;
  readonly now?: () => number;
  readonly logger?: AiLogger;
}

export interface DictationResult {
  readonly reply: DictationReply;
  /** For tests and the logs: what was recorded. */
  readonly trace: {
    readonly outcome: AiRefusal | DictationFinishOutcome | "invalid";
    readonly billedSeconds: number;
    readonly attempts: number;
  };
}

const RETRYABLE = new Set<AiExecution["status"]>(["timeout", "unavailable"]);
const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error);

function failureOf(error: unknown): { status: AiExecution["status"]; httpStatus: number | null } {
  if (error instanceof AiProviderError) return { status: error.kind, httpStatus: error.httpStatus };
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError")
    return { status: "timeout", httpStatus: null };
  return { status: "unavailable", httpStatus: null };
}

/** What a transcription is billed: its length rounded up, at least the provider's minimum. */
export function billedSeconds(transcription: Transcription): number {
  const measured = transcription.durationSeconds;
  if (measured === null || !Number.isFinite(measured) || measured < 0)
    return DICTATION_LIMITS.reserveSeconds;
  return Math.min(600, Math.max(DICTATION_LIMITS.minBilledSeconds, Math.ceil(measured)));
}

export async function transcribeDictation(
  input: DictationInput,
  deps: DictationDeps,
): Promise<DictationResult> {
  const invalid = (message: string): DictationResult => ({
    reply: { status: "invalid", message },
    trace: { outcome: "invalid", billedSeconds: 0, attempts: 0 },
  });
  if (input.audio.length > DICTATION_LIMITS.maxBytes) return invalid(DICTATION_MESSAGES.too_long);
  const format = input.audio.length >= DICTATION_LIMITS.minBytes ? sniffAudio(input.audio) : null;
  if (format === null) return invalid(DICTATION_MESSAGES.not_audio);

  const refused = (outcome: AiRefusal): DictationResult => ({
    reply: noticeFor(outcome),
    trace: { outcome, billedSeconds: 0, attempts: 0 },
  });
  if (deps.ledger === null || deps.transcriber === null) return refused("not_configured");
  const now = deps.now ?? Date.now;
  const transcriber = deps.transcriber;

  let begun: Awaited<ReturnType<DictationLedger["beginDictation"]>>;
  try {
    begun = await deps.ledger.beginDictation({
      tenantId: input.tenantId,
      reserveSeconds: DICTATION_LIMITS.reserveSeconds,
      visitor: input.visitor,
    });
  } catch (error) {
    // Without the ledger nothing can be accounted for: no call to the provider.
    deps.logger?.event("ai.begin_failed", { profile: "dictation", error: errorName(error) });
    return refused("not_configured");
  }
  if (begun.outcome !== "reserved") {
    deps.logger?.event("ai.refused", { profile: "dictation", outcome: begun.outcome });
    return refused(begun.outcome);
  }

  const executions: DictationExecution[] = [];
  let transcription: Transcription | null = null;
  let last: AiExecution["status"] = "unavailable";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const started = now();
    try {
      const result = await transcriber.transcribe(
        { audio: input.audio, format, prompt: input.prompt },
        AbortSignal.timeout(DICTATION_LIMITS.timeoutMs),
      );
      executions.push({
        provider: transcriber.name,
        model: result.model,
        status: "ok",
        audioSeconds: billedSeconds(result),
        latencyMs: Math.max(0, Math.round(now() - started)),
        httpStatus: 200,
      });
      transcription = result;
      break;
    } catch (error) {
      const failure = failureOf(error);
      executions.push({
        provider: transcriber.name,
        model: transcriber.model,
        status: failure.status,
        audioSeconds: 0,
        latencyMs: Math.max(0, Math.round(now() - started)),
        httpStatus: failure.httpStatus,
      });
      last = failure.status;
      if (!RETRYABLE.has(failure.status)) break;
    }
  }

  const outcome: DictationFinishOutcome =
    transcription !== null
      ? "transcribed"
      : last === "error"
        ? "provider_error"
        : "provider_unavailable";
  try {
    await deps.ledger.finishDictation(begun.requestId, outcome, executions);
  } catch (error) {
    // The reservation expires on its own and counts as used (ADR-036): the text stands.
    deps.logger?.event("ai.finish_failed", { profile: "dictation", error: errorName(error) });
  }
  const billed = executions.reduce((sum, execution) => sum + execution.audioSeconds, 0);
  deps.logger?.event("ai.finished", {
    profile: "dictation",
    outcome,
    attempts: executions.length,
    latencyMs: executions.reduce((sum, execution) => sum + execution.latencyMs, 0),
  });
  const trace = { outcome, billedSeconds: billed, attempts: executions.length };
  if (transcription === null)
    return { reply: noticeFor(outcome === "transcribed" ? "provider_error" : outcome), trace };

  const text = dictationText(transcription, input.prompt);
  return {
    reply: text
      ? { status: "transcribed", text }
      : { status: "empty", message: DICTATION_MESSAGES.empty },
    trace,
  };
}
