import { AiProviderError, type AiProvider } from "@rikuy/core";
import { z } from "zod";

/**
 * Groq through its OpenAI-compatible chat completions API (ADR-036), with fetch and no
 * SDK. One key for the whole platform: Groq's limits are per organization, so more keys
 * would not add capacity. The key travels only in the Authorization header; it never
 * reaches an error message or a log.
 */

export const GROQ_CHAT_COMPLETIONS = "https://api.groq.com/openai/v1/chat/completions";

export interface GroqProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  /** For tests. */
  readonly fetch?: typeof fetch;
  readonly url?: string;
}

const completionSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable().optional() }) }))
    .min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
  }),
});

/** How an HTTP status maps to the gateway: retry (down), stop (saturated) or a mistake. */
export function groqFailureKind(status: number): "rate_limited" | "unavailable" | "error" {
  if (status === 429 || status === 498) return "rate_limited";
  if (status === 408 || status >= 500) return "unavailable";
  return "error";
}

export function createGroqProvider(options: GroqProviderOptions): AiProvider {
  const send = options.fetch ?? fetch;
  return {
    name: "groq",
    model: options.model,
    async complete(request, signal) {
      const response = await send(options.url ?? GROQ_CHAT_COMPLETIONS, {
        method: "POST",
        signal,
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: options.model,
          messages: request.messages.map(({ role, content }) => ({ role, content })),
          max_completion_tokens: request.maxOutputTokens,
          temperature: request.temperature,
          // gpt-oss reasons before answering: briefly, and without returning the reasoning.
          reasoning_effort: "low",
          include_reasoning: false,
        }),
      });
      if (!response.ok) {
        // The body is not read into the error: it could echo the request.
        throw new AiProviderError(groqFailureKind(response.status), response.status);
      }
      const parsed = completionSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new AiProviderError("error", response.status, "unexpected answer");
      const completion = parsed.data;
      return {
        text: completion.choices[0]?.message.content ?? "",
        inputTokens: completion.usage.prompt_tokens,
        outputTokens: completion.usage.completion_tokens,
        model: completion.model ?? options.model,
      };
    },
  };
}
