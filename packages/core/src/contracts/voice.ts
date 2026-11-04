/**
 * Voice for the visitor's assistant (ADR-041): the visitor dictates a question, a provider
 * transcribes it through the AI gateway with a quota of seconds, and the visitor reviews the
 * text before sending it. Answers are read aloud by the browser's own voice (no cost, nothing
 * leaves the device).
 */

export const DICTATION_LIMITS = {
  /** The longest recording: the browser stops by itself at this point. */
  maxSeconds: 30,
  /** What a dictation sets aside before calling the provider (the longest recording). */
  reserveSeconds: 30,
  /** The provider bills at least this much per transcription, however short. */
  minBilledSeconds: 10,
  /** 30 s of compressed speech is ~120–500 KB; anything near this is not a short question. */
  maxBytes: 2 * 1024 * 1024,
  /** Less than this cannot hold a word. */
  minBytes: 512,
  /** Per provider call; one retry when the provider is down or slow. */
  timeoutMs: 20_000,
  /** Dictations per visitor and hour (the database counts them apart from questions). */
  perVisitorHourly: 10,
} as const;

/** The audio containers the browsers record and the provider accepts. */
export const DICTATION_FORMATS = ["webm", "ogg", "mp4", "wav", "mpeg", "flac"] as const;
export type DictationFormat = (typeof DICTATION_FORMATS)[number];

/** What the browser gets back from POST /asistente/dictado. */
export type DictationReply =
  /** Text for the visitor to review in the question's field (never sent by itself). */
  | { readonly status: "transcribed"; readonly text: string }
  /** The recording held no words that could be understood. */
  | { readonly status: "empty"; readonly message: string }
  /** No transcription this time: a limit or the provider. The visitor can type instead. */
  | { readonly status: "notice"; readonly message: string }
  /** Not audio, too long or too short. */
  | { readonly status: "invalid"; readonly message: string };
