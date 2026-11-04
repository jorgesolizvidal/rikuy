import { AiProviderError, DICTATION_FILE_NAMES, type SpeechTranscriber } from "@rikuy/core";
import { z } from "zod";

import { groqFailureKind } from "./groq-provider";

/**
 * Groq's speech to text (Whisper, OpenAI-compatible transcriptions API) for dictation
 * (ADR-041), with fetch and no SDK. The same platform key as the chat model; Groq bills at
 * least 10 s per request. The audio goes in the request and is not kept by Rikuy; the key
 * travels only in the Authorization header and never reaches an error or a log.
 */

export const GROQ_TRANSCRIPTIONS = "https://api.groq.com/openai/v1/audio/transcriptions";
export const GROQ_DEFAULT_TRANSCRIPTION_MODEL = "whisper-large-v3-turbo";

export interface GroqTranscriberOptions {
  readonly apiKey: string;
  readonly model?: string;
  /** For tests. */
  readonly fetch?: typeof fetch;
  readonly url?: string;
}

const transcriptionSchema = z.object({
  text: z.string(),
  duration: z.number().nonnegative().optional(),
  segments: z
    .array(
      z.object({
        text: z.string(),
        no_speech_prob: z.number().optional(),
      }),
    )
    .optional(),
});

export function createGroqTranscriber(options: GroqTranscriberOptions): SpeechTranscriber {
  const send = options.fetch ?? fetch;
  const model = options.model ?? GROQ_DEFAULT_TRANSCRIPTION_MODEL;
  return {
    name: "groq",
    model,
    async transcribe(request, signal) {
      const form = new FormData();
      // A copy into a plain ArrayBuffer: Blob does not take a view of a shared buffer.
      const audio = new Uint8Array(request.audio.byteLength);
      audio.set(request.audio);
      form.append("file", new Blob([audio.buffer]), DICTATION_FILE_NAMES[request.format]);
      form.append("model", model);
      // Segments with their no-speech probability: silence is dropped before the visitor sees it.
      form.append("response_format", "verbose_json");
      form.append("temperature", "0");
      if (request.prompt) form.append("prompt", request.prompt);
      const response = await send(options.url ?? GROQ_TRANSCRIPTIONS, {
        method: "POST",
        signal,
        headers: { authorization: `Bearer ${options.apiKey}` },
        body: form,
      });
      if (!response.ok) {
        // The body is not read into the error: it could echo the request.
        throw new AiProviderError(groqFailureKind(response.status), response.status);
      }
      const parsed = transcriptionSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new AiProviderError("error", response.status, "unexpected answer");
      return {
        text: parsed.data.text,
        durationSeconds: parsed.data.duration ?? null,
        segments:
          parsed.data.segments?.map((segment) => ({
            text: segment.text,
            noSpeechProb: segment.no_speech_prob ?? null,
          })) ?? null,
        model,
      };
    },
  };
}
