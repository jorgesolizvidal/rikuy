import { AiProviderError } from "@rikuy/core";
import { describe, expect, it, vi } from "vitest";

import { createGroqProvider, GROQ_CHAT_COMPLETIONS, groqFailureKind } from "./groq-provider";

// Not a key: low entropy on purpose, so no secret scanner mistakes it for one.
const KEY = `gsk_${"x".repeat(32)}`;
const MESSAGES = [
  { role: "system" as const, content: "Responde solo con la palabra: listo" },
  { role: "user" as const, content: "¿Estás disponible?" },
];
const request = { messages: MESSAGES, maxOutputTokens: 256, temperature: 0 };

function respond(status: number, body: unknown) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("the Groq provider", () => {
  it("sends one chat completion with the platform key, brief reasoning and the answer limit", async () => {
    const send = respond(200, {
      model: "openai/gpt-oss-120b",
      choices: [{ message: { content: "listo" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 74, completion_tokens: 21, total_tokens: 95 },
    });
    const provider = createGroqProvider({ apiKey: KEY, model: "openai/gpt-oss-120b", fetch: send });
    const completion = await provider.complete(request, new AbortController().signal);

    expect(completion).toEqual({
      text: "listo",
      inputTokens: 74,
      outputTokens: 21,
      model: "openai/gpt-oss-120b",
    });
    const [url, init] = send.mock.calls[0] ?? [];
    expect(url).toBe(GROQ_CHAT_COMPLETIONS);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "openai/gpt-oss-120b",
      messages: MESSAGES,
      max_completion_tokens: 256,
      temperature: 0,
      reasoning_effort: "low",
      include_reasoning: false,
    });
  });

  it("passes the gateway's time limit to the request", async () => {
    const send = respond(200, {
      choices: [{ message: { content: "" } }],
      usage: { prompt_tokens: 1, completion_tokens: 0 },
    });
    const controller = new AbortController();
    await createGroqProvider({ apiKey: KEY, model: "m", fetch: send }).complete(
      request,
      controller.signal,
    );
    expect(send.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("returns an empty answer with its tokens (they were spent)", async () => {
    const send = respond(200, {
      choices: [{ message: { content: null } }],
      usage: { prompt_tokens: 74, completion_tokens: 256 },
    });
    const completion = await createGroqProvider({ apiKey: KEY, model: "m", fetch: send }).complete(
      request,
      new AbortController().signal,
    );
    expect(completion).toMatchObject({ text: "", outputTokens: 256, model: "m" });
  });

  it.each([
    [429, "rate_limited"],
    [498, "rate_limited"],
    [500, "unavailable"],
    [503, "unavailable"],
    [408, "unavailable"],
    [400, "error"],
    [401, "error"],
    [413, "error"],
  ] as const)("maps an HTTP %i to %s", async (status, kind) => {
    expect(groqFailureKind(status)).toBe(kind);
    const send = respond(status, { error: { message: `bad key ${KEY}` } });
    const failure = await createGroqProvider({ apiKey: KEY, model: "m", fetch: send })
      .complete(request, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AiProviderError);
    expect(failure).toMatchObject({ kind, httpStatus: status });
    expect(String((failure as Error).message)).not.toContain(KEY);
  });

  it("refuses an answer it cannot read", async () => {
    const send = respond(200, { nothing: true });
    await expect(
      createGroqProvider({ apiKey: KEY, model: "m", fetch: send }).complete(
        request,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "error" });
  });

  it("lets a network failure through, for the gateway to retry", async () => {
    const send = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      createGroqProvider({ apiKey: KEY, model: "m", fetch: send }).complete(
        request,
        new AbortController().signal,
      ),
    ).rejects.toThrow(TypeError);
  });
});
