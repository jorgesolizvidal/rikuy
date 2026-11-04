"use client";

import { DICTATION_LIMITS, type DictationReply } from "@rikuy/core/assistant-client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Voice for the assistant's panel (ADR-041), loaded with it (never with the page):
 *
 * - dictation: the browser records up to 30 s, sends the recording to this portal, and the
 *   text comes back for the visitor to review in the question's field (never sent by itself);
 * - reading aloud: the browser's own voice reads an answer (nothing leaves the device).
 *
 * Without a microphone, without permission or with the provider down, the visitor types: a
 * message says so next to the field and nothing else changes.
 */

const ENDPOINT = "/asistente/dictado";

/** What the browsers record, best first (Chrome and Firefox: Opus; Safari: AAC in MP4). */
const RECORDING_TYPES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4",
  "audio/webm",
];

/** Less than this holds no word: not worth a request (nor its 10 s of quota). */
const SHORTEST_MS = 700;

export const VOICE_MESSAGES = {
  denied: "Sin permiso para usar el micrófono. Puedes escribir tu pregunta.",
  noMicrophone: "No encontramos un micrófono en este dispositivo. Puedes escribir tu pregunta.",
  failed: "No pude usar el micrófono. Puedes escribir tu pregunta.",
  tooShort: "La grabación fue muy corta. Mantén el micrófono abierto mientras hablas.",
  offline: "No pude pasar tu voz a texto. Revisa tu conexión o escribe tu pregunta.",
  review: "Revisa el texto y pulsa «Enviar».",
} as const;

export function dictationSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof window.MediaRecorder === "function"
  );
}

function recordingType(): string {
  return RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function microphoneProblem(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return VOICE_MESSAGES.denied;
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return VOICE_MESSAGES.noMicrophone;
  return VOICE_MESSAGES.failed;
}

export type DictationState =
  | { readonly phase: "idle" }
  | { readonly phase: "starting" }
  | { readonly phase: "recording"; readonly seconds: number }
  | { readonly phase: "sending" };

/**
 * One dictation at a time. `onText` gets the text to review; `onMessage` what to tell the
 * visitor (a problem, or that the text is ready to review).
 */
export function useDictation(options: {
  readonly onText: (text: string) => void;
  readonly onMessage: (message: string | null) => void;
}) {
  const [state, setState] = useState<DictationState>({ phase: "idle" });
  const callbacks = useRef(options);
  useEffect(() => {
    callbacks.current = options;
  });
  const session = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    timer: number;
    started: number;
    cancelled: boolean;
  } | null>(null);

  const release = useCallback(() => {
    const current = session.current;
    if (!current) return;
    window.clearInterval(current.timer);
    for (const track of current.stream.getTracks()) track.stop();
    session.current = null;
  }, []);

  const send = useCallback(async (recording: Blob) => {
    setState({ phase: "sending" });
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": recording.type || "audio/webm" },
        body: recording,
      });
      const reply = (await response.json()) as DictationReply;
      if (reply.status === "transcribed") {
        callbacks.current.onText(reply.text);
        callbacks.current.onMessage(VOICE_MESSAGES.review);
      } else {
        callbacks.current.onMessage(reply.message || VOICE_MESSAGES.offline);
      }
    } catch {
      callbacks.current.onMessage(VOICE_MESSAGES.offline);
    } finally {
      setState({ phase: "idle" });
    }
  }, []);

  const stop = useCallback(() => {
    const current = session.current;
    if (current && current.recorder.state !== "inactive") current.recorder.stop();
  }, []);

  /** Throws the recording away (Escape, closing the panel). */
  const cancel = useCallback(() => {
    const current = session.current;
    if (!current) return;
    current.cancelled = true;
    if (current.recorder.state !== "inactive") current.recorder.stop();
    release();
    setState({ phase: "idle" });
  }, [release]);

  const start = useCallback(async () => {
    if (session.current || !dictationSupported()) return;
    callbacks.current.onMessage(null);
    setState({ phase: "starting" });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      setState({ phase: "idle" });
      callbacks.current.onMessage(microphoneProblem(error));
      return;
    }
    let recorder: MediaRecorder;
    try {
      const type = recordingType();
      recorder = new MediaRecorder(
        stream,
        type ? { mimeType: type, audioBitsPerSecond: 32_000 } : {},
      );
    } catch (error) {
      for (const track of stream.getTracks()) track.stop();
      setState({ phase: "idle" });
      callbacks.current.onMessage(microphoneProblem(error));
      return;
    }
    const chunks: Blob[] = [];
    const started = performance.now();
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener("stop", () => {
      const current = session.current;
      const cancelled = current?.cancelled ?? true;
      const lasted = performance.now() - started;
      release();
      if (cancelled) return;
      if (lasted < SHORTEST_MS) {
        setState({ phase: "idle" });
        callbacks.current.onMessage(VOICE_MESSAGES.tooShort);
        return;
      }
      void send(new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || "audio/webm" }));
    });
    const timer = window.setInterval(() => {
      const seconds = Math.floor((performance.now() - started) / 1000);
      if (seconds >= DICTATION_LIMITS.maxSeconds) {
        if (recorder.state !== "inactive") recorder.stop();
        return;
      }
      setState((current) =>
        current.phase === "recording" && current.seconds !== seconds
          ? { phase: "recording", seconds }
          : current,
      );
    }, 250);
    session.current = { recorder, stream, timer, started, cancelled: false };
    recorder.start();
    setState({ phase: "recording", seconds: 0 });
  }, [release, send]);

  // Leaving the page or closing the panel never leaves the microphone open.
  useEffect(() => () => cancel(), [cancel]);

  return { state, start, stop, cancel };
}

// ── Reading aloud ───────────────────────────────────────────────────────────

export function speechSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof window.SpeechSynthesisUtterance === "function"
  );
}

/** Voices tried first for each language: the region's own Spanish, then Latin America's. */
const PREFERRED: Readonly<Record<"es" | "en", readonly string[]>> = {
  es: ["es-bo", "es-419", "es-us", "es-mx", "es-ar", "es-co", "es-pe", "es-cl", "es-es"],
  en: ["en-us", "en-gb"],
};

/**
 * The same voice for the same language on the same device (ADR-022): by preferred region,
 * then any voice of the language, a voice of the device before one from the network, and by
 * name to break ties.
 */
export function pickVoice(
  voices: readonly SpeechSynthesisVoice[],
  lang: "es" | "en",
): SpeechSynthesisVoice | null {
  const tag = (voice: SpeechSynthesisVoice) => voice.lang.replace("_", "-").toLowerCase();
  const sorted = [...voices].sort(
    (a, b) => Number(b.localService) - Number(a.localService) || a.name.localeCompare(b.name),
  );
  for (const wanted of PREFERRED[lang]) {
    const voice = sorted.find((candidate) => tag(candidate) === wanted);
    if (voice) return voice;
  }
  return sorted.find((candidate) => tag(candidate).startsWith(lang)) ?? null;
}

/** Short pieces: some browsers stop a long utterance after ~15 s. */
export function speechPieces(text: string, max = 220): string[] {
  const sentences =
    text
      .replace(/\s+/gu, " ")
      .trim()
      .match(/[^.!?;:]+[.!?;:]*/gu) ?? [];
  const pieces: string[] = [];
  let current = "";
  for (const sentence of sentences.map((item) => item.trim()).filter(Boolean)) {
    if (current && current.length + sentence.length + 1 > max) {
      pieces.push(current);
      current = "";
    }
    current = current ? `${current} ${sentence}` : sentence;
    while (current.length > max) {
      const cut = current.lastIndexOf(" ", max);
      const at = cut > max / 2 ? cut : max;
      pieces.push(current.slice(0, at).trim());
      current = current.slice(at).trim();
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

let voicesReady: Promise<readonly SpeechSynthesisVoice[]> | null = null;

/** Some browsers list their voices only after a moment. */
function voices(): Promise<readonly SpeechSynthesisVoice[]> {
  voicesReady ??= new Promise((resolve) => {
    const now = window.speechSynthesis.getVoices();
    if (now.length > 0) {
      resolve(now);
      return;
    }
    const done = () => resolve(window.speechSynthesis.getVoices());
    window.speechSynthesis.addEventListener("voiceschanged", done, { once: true });
    window.setTimeout(done, 1500);
  });
  return voicesReady;
}

let reading = 0;

/** Reads `text`; `onEnd` runs once when it ends, is stopped, or cannot start. */
export async function speak(text: string, lang: "es" | "en", onEnd: () => void): Promise<void> {
  const synth = window.speechSynthesis;
  synth.cancel();
  const id = (reading += 1);
  const voice = pickVoice(await voices(), lang);
  if (id !== reading) return;
  const pieces = speechPieces(text);
  if (pieces.length === 0) {
    onEnd();
    return;
  }
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    onEnd();
  };
  pieces.forEach((piece, index) => {
    const utterance = new SpeechSynthesisUtterance(piece);
    utterance.lang = voice?.lang ?? (lang === "en" ? "en-US" : "es-419");
    if (voice) utterance.voice = voice;
    utterance.rate = 1;
    utterance.addEventListener("error", finish);
    if (index === pieces.length - 1) utterance.addEventListener("end", finish);
    synth.speak(utterance);
  });
}

export function stopSpeaking(): void {
  if (!speechSupported()) return;
  reading += 1;
  window.speechSynthesis.cancel();
}
