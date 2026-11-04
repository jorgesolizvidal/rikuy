import { AiProviderError } from "@rikuy/core";
import { describe, expect, it, vi } from "vitest";

import { createGroqTranscriber, GROQ_TRANSCRIPTIONS } from "./groq-transcriber";

// Not a key: low entropy on purpose, so no secret scanner mistakes it for one.
const KEY = `gsk_${"x".repeat(32)}`;
const AUDIO = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);

function respond(status: number, body: unknown) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("the Groq transcriber", () => {
  it("sends the recording as a file with the model, segments and the places to spell", async () => {
    const send = respond(200, {
      text: " ¿Dónde está el mirador?",
      language: "spanish",
      duration: 2.4,
      segments: [{ id: 0, text: " ¿Dónde está el mirador?", no_speech_prob: 0.01 }],
    });
    const transcriber = createGroqTranscriber({ apiKey: KEY, fetch: send });
    const result = await transcriber.transcribe(
      { audio: AUDIO, format: "webm", prompt: "Municipio Demo. Mirador del Valle." },
      new AbortController().signal,
    );
    expect(result).toEqual({
      text: " ¿Dónde está el mirador?",
      durationSeconds: 2.4,
      segments: [{ text: " ¿Dónde está el mirador?", noSpeechProb: 0.01 }],
      model: "whisper-large-v3-turbo",
    });

    const [url, init] = send.mock.calls[0] ?? [];
    expect(url).toBe(GROQ_TRANSCRIPTIONS);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    const form = init?.body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.get("prompt")).toBe("Municipio Demo. Mirador del Valle.");
    const file = form.get("file") as File;
    expect(file.name).toBe("dictado.webm");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(AUDIO);
  });

  it("maps failures like the chat provider, without the body or the key in the error", async () => {
    for (const [status, kind] of [
      [429, "rate_limited"],
      [503, "unavailable"],
      [400, "error"],
    ] as const) {
      const transcriber = createGroqTranscriber({
        apiKey: KEY,
        fetch: respond(status, { error: { message: `echo ${KEY}` } }),
      });
      const failure = await transcriber
        .transcribe({ audio: AUDIO, format: "mp4", prompt: null }, new AbortController().signal)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AiProviderError);
      expect(failure).toMatchObject({ kind, httpStatus: status });
      expect(String((failure as Error).message)).not.toContain(KEY);
    }
  });

  it("refuses an answer it does not understand", async () => {
    const transcriber = createGroqTranscriber({ apiKey: KEY, fetch: respond(200, { nope: 1 }) });
    await expect(
      transcriber.transcribe(
        { audio: AUDIO, format: "wav", prompt: null },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "error" });
  });
});
