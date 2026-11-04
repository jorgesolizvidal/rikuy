import { describe, expect, it, vi } from "vitest";

import { DICTATION_LIMITS } from "../../contracts/voice";
import {
  billedSeconds,
  DICTATION_MESSAGES,
  dictationPrompt,
  dictationText,
  sniffAudio,
  transcribeDictation,
  type DictationLedger,
  type SpeechTranscriber,
  type Transcription,
} from "./dictation";
import { AiProviderError } from "./gateway";
import { createSimulatedTranscriber, SIMULATED_DICTATION } from "./simulated";

const TENANT = "aaaaaaaa-0000-4000-8000-000000000001";

/** A minimal WAV header followed by silence (and, optionally, a marker in its bytes). */
function wav(extra = "", size = 4096): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WAVE"), 8);
  bytes.set(new TextEncoder().encode(extra), 64);
  return bytes;
}

const webm = () => {
  const bytes = new Uint8Array(2048);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  return bytes;
};

function setup(
  options: {
    outcome?: Awaited<ReturnType<DictationLedger["beginDictation"]>>["outcome"];
    transcribe?: SpeechTranscriber["transcribe"];
    begin?: DictationLedger["beginDictation"];
    finish?: DictationLedger["finishDictation"];
  } = {},
) {
  const ledger = {
    beginDictation: vi.fn(
      options.begin ?? (async () => ({ requestId: "r1", outcome: options.outcome ?? "reserved" })),
    ),
    finishDictation: vi.fn(options.finish ?? (async () => undefined)),
  };
  const transcriber = {
    name: "groq",
    model: "whisper-large-v3-turbo",
    transcribe: vi.fn(
      options.transcribe ??
        (async (): Promise<Transcription> => ({
          text: " ¿Dónde queda   el mirador? ",
          durationSeconds: 3.2,
          segments: null,
          model: "whisper-large-v3-turbo",
        })),
    ),
  };
  return { ledger, transcriber };
}

const input = (audio: Uint8Array = webm()) => ({
  tenantId: TENANT,
  audio,
  visitor: "203.0.113.7",
  prompt: "Municipio Demo. Mirador del Valle.",
});

describe("the recording", () => {
  it("is recognized by its first bytes, not by what the browser says", () => {
    const of = (...values: (number | string)[]) => {
      const bytes = new Uint8Array(32);
      let at = 0;
      for (const value of values) {
        const chunk = typeof value === "string" ? new TextEncoder().encode(value) : [value];
        bytes.set(chunk, at);
        at += chunk.length;
      }
      return bytes;
    };
    expect(sniffAudio(webm())).toBe("webm");
    expect(sniffAudio(of("OggS"))).toBe("ogg");
    expect(sniffAudio(of(0, 0, 0, 0x20, "ftypM4A "))).toBe("mp4");
    expect(sniffAudio(wav())).toBe("wav");
    expect(sniffAudio(of("fLaC"))).toBe("flac");
    expect(sniffAudio(of("ID3"))).toBe("mpeg");
    expect(sniffAudio(of(0xff, 0xfb))).toBe("mpeg");
    expect(sniffAudio(of("<!doctype html>"))).toBeNull();
    expect(sniffAudio(new Uint8Array(4))).toBeNull();
  });

  it("that is not audio, too short or too long never reaches the ledger", async () => {
    for (const [audio, message] of [
      [new TextEncoder().encode("<html>".repeat(200)), DICTATION_MESSAGES.not_audio],
      [webm().subarray(0, 100), DICTATION_MESSAGES.not_audio],
      [new Uint8Array(DICTATION_LIMITS.maxBytes + 1), DICTATION_MESSAGES.too_long],
    ] as const) {
      const { ledger, transcriber } = setup();
      const { reply } = await transcribeDictation(input(audio), { ledger, transcriber });
      expect(reply).toEqual({ status: "invalid", message });
      expect(ledger.beginDictation).not.toHaveBeenCalled();
    }
  });
});

describe("dictation through the gateway", () => {
  it("reserves the longest recording, transcribes and settles what the provider bills", async () => {
    const { ledger, transcriber } = setup();
    const { reply, trace } = await transcribeDictation(input(), { ledger, transcriber });
    expect(reply).toEqual({ status: "transcribed", text: "¿Dónde queda el mirador?" });
    expect(ledger.beginDictation).toHaveBeenCalledWith({
      tenantId: TENANT,
      reserveSeconds: 30,
      visitor: "203.0.113.7",
    });
    expect(transcriber.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ format: "webm", prompt: "Municipio Demo. Mirador del Valle." }),
      expect.any(AbortSignal),
    );
    // 3.2 s is billed as the provider's minimum of 10 s.
    expect(trace).toEqual({ outcome: "transcribed", billedSeconds: 10, attempts: 1 });
    expect(ledger.finishDictation).toHaveBeenCalledWith("r1", "transcribed", [
      expect.objectContaining({ status: "ok", audioSeconds: 10, httpStatus: 200 }),
    ]);
  });

  it("never calls the provider when a limit refuses, and says so in words", async () => {
    for (const outcome of [
      "tenant_quota",
      "platform_quota",
      "visitor_limit",
      "tenant_unavailable",
    ] as const) {
      const { ledger, transcriber } = setup({ outcome });
      const { reply } = await transcribeDictation(input(), { ledger, transcriber });
      expect(transcriber.transcribe).not.toHaveBeenCalled();
      expect(ledger.finishDictation).not.toHaveBeenCalled();
      expect(reply.status).toBe("notice");
      expect(reply).toHaveProperty(
        "message",
        outcome === "tenant_unavailable"
          ? DICTATION_MESSAGES.unavailable
          : DICTATION_MESSAGES[outcome],
      );
    }
  });

  it("without AI on this deployment, or with the ledger down, nothing is called", async () => {
    const { ledger, transcriber } = setup({
      begin: async () => {
        throw new Error("connection refused");
      },
    });
    expect((await transcribeDictation(input(), { ledger: null, transcriber })).reply.status).toBe(
      "notice",
    );
    expect((await transcribeDictation(input(), { ledger, transcriber: null })).reply.status).toBe(
      "notice",
    );
    expect((await transcribeDictation(input(), { ledger, transcriber })).reply).toEqual({
      status: "notice",
      message: DICTATION_MESSAGES.unavailable,
    });
    expect(transcriber.transcribe).not.toHaveBeenCalled();
  });

  it("retries once when the provider is down, and records both calls", async () => {
    let calls = 0;
    const { ledger, transcriber } = setup({
      transcribe: async () => {
        calls += 1;
        if (calls === 1) throw new AiProviderError("unavailable", 503);
        return { text: "Hola", durationSeconds: 14.2, segments: null, model: "w" };
      },
    });
    const { reply, trace } = await transcribeDictation(input(), { ledger, transcriber });
    expect(reply).toEqual({ status: "transcribed", text: "Hola" });
    expect(trace).toEqual({ outcome: "transcribed", billedSeconds: 15, attempts: 2 });
    expect(ledger.finishDictation).toHaveBeenCalledWith("r1", "transcribed", [
      expect.objectContaining({ status: "unavailable", audioSeconds: 0, httpStatus: 503 }),
      expect.objectContaining({ status: "ok", audioSeconds: 15 }),
    ]);
  });

  it("does not retry a saturated provider or a refused request", async () => {
    for (const [error, outcome] of [
      [new AiProviderError("rate_limited", 429), "provider_unavailable"],
      [new AiProviderError("error", 400), "provider_error"],
    ] as const) {
      const { ledger, transcriber } = setup({
        transcribe: async () => {
          throw error;
        },
      });
      const { reply, trace } = await transcribeDictation(input(), { ledger, transcriber });
      expect(transcriber.transcribe).toHaveBeenCalledTimes(1);
      expect(trace).toEqual({ outcome, billedSeconds: 0, attempts: 1 });
      expect(reply).toEqual({ status: "notice", message: DICTATION_MESSAGES.unavailable });
      expect(ledger.finishDictation).toHaveBeenCalledWith("r1", outcome, [
        expect.objectContaining({ audioSeconds: 0 }),
      ]);
    }
  });

  it("keeps the text when settling fails (the reservation expires and counts)", async () => {
    const { ledger, transcriber } = setup({
      finish: async () => {
        throw new Error("lost");
      },
    });
    expect((await transcribeDictation(input(), { ledger, transcriber })).reply.status).toBe(
      "transcribed",
    );
  });

  it("says it heard nothing instead of writing a model's stock phrase", async () => {
    const { ledger, transcriber } = setup({
      transcribe: async () => ({
        text: "Subtítulos realizados por la comunidad de Amara.org",
        durationSeconds: 2,
        segments: null,
        model: "w",
      }),
    });
    const { reply, trace } = await transcribeDictation(input(), { ledger, transcriber });
    expect(reply).toEqual({ status: "empty", message: DICTATION_MESSAGES.empty });
    // The provider still billed it.
    expect(trace.billedSeconds).toBe(10);
  });
});

describe("the text the visitor reviews", () => {
  const of = (text: string, segments: Transcription["segments"] = null): Transcription => ({
    text,
    durationSeconds: 3,
    segments,
    model: "w",
  });

  it("drops segments without speech, stock phrases and the prompt read back", () => {
    expect(
      dictationText(
        of("¿Qué hay cerca? Gracias por ver el video", [
          { text: "¿Qué hay cerca?", noSpeechProb: 0.02 },
          { text: "Gracias por ver el video", noSpeechProb: 0.8 },
        ]),
        null,
      ),
    ).toBe("¿Qué hay cerca?");
    expect(dictationText(of("Gracias por ver el video."), null)).toBe("");
    expect(dictationText(of(" Thank you. "), null)).toBe("");
    expect(dictationText(of("Mirador del Valle."), "Municipio Demo. Mirador del Valle.")).toBe("");
    expect(dictationText(of("¿Cómo llego al Mirador del Valle?"), "Mirador del Valle.")).toBe(
      "¿Cómo llego al Mirador del Valle?",
    );
  });

  it("fits the question's field, cut at a word", () => {
    const text = dictationText(of("palabra ".repeat(120)), null);
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text.endsWith("palabra")).toBe(true);
  });

  it("bills at least 10 s, rounded up, and the reservation when the length is unknown", () => {
    expect(billedSeconds(of("x"))).toBe(10);
    expect(billedSeconds({ ...of("x"), durationSeconds: 21.1 })).toBe(22);
    expect(billedSeconds({ ...of("x"), durationSeconds: null })).toBe(30);
  });

  it("asks the provider to spell the municipality's places, briefly", () => {
    const prompt = dictationPrompt(
      "Municipio Demo",
      Array.from({ length: 80 }, (_, index) => `Lugar   número ${index}`),
    );
    expect(prompt.startsWith("Municipio Demo. Lugar número 0. Lugar número 1.")).toBe(true);
    expect(prompt.length).toBeLessThanOrEqual(600);
  });
});

describe("the simulated transcriber", () => {
  it("hears the same question in any recording, and fails or hears nothing on a marker", async () => {
    const transcriber = createSimulatedTranscriber();
    const ledger = setup().ledger;
    const deps = { ledger, transcriber };
    expect((await transcribeDictation(input(wav()), deps)).reply).toEqual({
      status: "transcribed",
      text: SIMULATED_DICTATION,
    });
    expect((await transcribeDictation(input(wav("[simular:silencio]")), deps)).reply.status).toBe(
      "empty",
    );
    expect((await transcribeDictation(input(wav("[simular:caida]")), deps)).trace).toMatchObject({
      outcome: "provider_unavailable",
      attempts: 2,
    });
    expect((await transcribeDictation(input(wav("[simular:rechazo]")), deps)).trace).toMatchObject({
      outcome: "provider_error",
      attempts: 1,
    });
  });
});
